import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { posix as posixPath, win32 as winPath } from 'node:path';

import { z } from 'zod/v4';

import type { CommandContext } from '../commands/context.js';
import { SecurityError } from '../errors.js';
import { assertPathIsSafe } from '../security/pathSafety.js';
import type { StateLayout } from './stateRoot.js';

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;
const WINDOWS_DEVICE = /^\\\\[?.]\\/;
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]?$/;
const MAX_WORKSPACE_ROOTS = 64;
const MAX_ROOT_LENGTH = 4_096;

export const DEFAULT_HARD_MAX_CYCLES = 10;
export const DEFAULT_MAX_CYCLES = 10;
export const DEFAULT_STALE_AFTER_S = 3_600;
export const PHASE5_CONFIG_FILENAME = 'config.json';

export const Phase5ConfigSchema = z.object({
  workspace_roots: z.array(z.string().trim().min(1).max(MAX_ROOT_LENGTH)).max(MAX_WORKSPACE_ROOTS),
  default_max_cycles: z.number().int().nonnegative(),
  hard_max_cycles: z.number().int().nonnegative(),
  default_stale_after_s: z.number().int().positive(),
}).strict();

export type Phase5ConfigFile = z.infer<typeof Phase5ConfigSchema>;

export interface Phase5Config {
  readonly workspaceRoots: readonly string[];
  readonly defaultMaxCycles: number;
  readonly hardMaxCycles: number;
  readonly defaultStaleAfterS: number;
}

function pathApi(platform: NodeJS.Platform): typeof winPath | typeof posixPath {
  return platform === 'win32' ? winPath : posixPath;
}

function canonicalPath(value: string, platform: NodeJS.Platform): string {
  const path = pathApi(platform);
  const resolved = path.resolve(value).replace(/[\\/]$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fail(message: string, remedy: string): never {
  throw new SecurityError(message, remedy);
}

function validateRootSyntax(value: string, platform: NodeJS.Platform): string {
  const root = value.trim();
  if (root === '' || root.length > MAX_ROOT_LENGTH || /[\r\n\0]/.test(root)) {
    fail('The Phase 5 workspace-root configuration is invalid.', 'Edit the protected Phase 5 configuration and retry.');
  }
  const path = pathApi(platform);
  if (platform === 'win32') {
    if (
      WINDOWS_DEVICE.test(root)
      || WINDOWS_UNC.test(root)
      || !WINDOWS_ABSOLUTE.test(root)
      || WINDOWS_ROOT.test(root)
    ) {
      fail('A Phase 5 workspace root must be a non-root local Windows path.', 'Use a child root such as C:\\AgentProjects.');
    }
  } else if (!path.isAbsolute(root) || path.normalize(root) === path.parse(root).root) {
    fail('A Phase 5 workspace root must be a non-root absolute POSIX path.', 'Configure a project parent such as /srv/AgentProjects.');
  }
  if (root.split(/[\\/]/).some((segment) => segment === '..')) {
    fail('A Phase 5 workspace root must not contain traversal.', 'Remove .. segments from the configured root.');
  }
  return root;
}

function normalizeConfig(value: unknown, platform: NodeJS.Platform): Phase5Config {
  const parsed = Phase5ConfigSchema.safeParse(value);
  if (!parsed.success) {
    fail('The Phase 5 configuration has an invalid shape.', 'Restore the documented Phase 5 configuration fields and retry.');
  }
  if (parsed.data.hard_max_cycles < 0 || parsed.data.default_max_cycles > parsed.data.hard_max_cycles) {
    fail('The Phase 5 cycle limits are invalid.', 'Set default_max_cycles no higher than hard_max_cycles.');
  }
  if (platform === 'win32' && parsed.data.workspace_roots.length === 0) {
    fail('The Phase 5 workspace-root allowlist is empty.', 'Configure at least one local workspace root and retry.');
  }
  const seen = new Set<string>();
  const workspaceRoots: string[] = [];
  for (const configuredRoot of parsed.data.workspace_roots) {
    const root = validateRootSyntax(configuredRoot, platform);
    const key = canonicalPath(root, platform);
    if (seen.has(key)) {
      fail('The Phase 5 workspace-root allowlist contains duplicates.', 'Keep each workspace root only once.');
    }
    seen.add(key);
    workspaceRoots.push(root);
  }
  return {
    workspaceRoots,
    defaultMaxCycles: parsed.data.default_max_cycles,
    hardMaxCycles: parsed.data.hard_max_cycles,
    defaultStaleAfterS: parsed.data.default_stale_after_s,
  };
}

export function defaultPhase5Config(platform: NodeJS.Platform): Phase5Config {
  return {
    workspaceRoots: platform === 'win32' ? ['C:\\AgentProjects', 'C:\\SallaProjects'] : [],
    defaultMaxCycles: DEFAULT_MAX_CYCLES,
    hardMaxCycles: DEFAULT_HARD_MAX_CYCLES,
    defaultStaleAfterS: DEFAULT_STALE_AFTER_S,
  };
}

function configFilePath(layout: StateLayout): string {
  return layout.configFile;
}

function assertConfigFileSecure(context: CommandContext): void {
  const path = configFilePath(context.layout);
  try {
    assertPathIsSafe(path, 'file', context.platform);
    const report = context.security.verify(path, 'file');
    if (!report.secure) {
      fail(
        'The Phase 5 configuration file is not protected: ' + report.problems.join('; ') + '.',
        'Run init again after correcting the configuration-file permissions.',
      );
    }
  } catch (cause) {
    if (cause instanceof SecurityError) throw cause;
    fail(
      'The Phase 5 configuration file could not be verified.',
      cause instanceof Error ? cause.message : 'Inspect the configuration file and retry.',
    );
  }
}

function readConfig(context: CommandContext): Phase5Config {
  const path = configFilePath(context.layout);
  assertConfigFileSecure(context);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    fail(
      'The Phase 5 configuration file could not be read.',
      cause instanceof Error ? cause.message : 'Inspect the configuration file and retry.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('The Phase 5 configuration is not valid JSON.', 'Restore valid JSON in the configuration file and retry.');
  }
  return normalizeConfig(parsed, context.platform);
}

/** Reads the protected runtime configuration; missing configuration fails closed. */
export function loadPhase5Config(context: CommandContext): Phase5Config {
  try {
    lstatSync(configFilePath(context.layout));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      fail(
        'The Phase 5 configuration file is missing.',
        'Run init to create the protected configuration before serving.',
      );
    }
    fail(
      'The Phase 5 configuration file could not be inspected.',
      cause instanceof Error ? cause.message : 'Inspect the configuration file and retry.',
    );
  }
  return readConfig(context);
}

/** Creates the protected default configuration on the explicit init path. */
export function ensurePhase5Config(context: CommandContext): Phase5Config {
  const path = configFilePath(context.layout);
  try {
    lstatSync(path);
    return readConfig(context);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (cause instanceof SecurityError) throw cause;
      fail(
        'The Phase 5 configuration file could not be inspected.',
        cause instanceof Error ? cause.message : 'Inspect the configuration file and retry.',
      );
    }
  }

  const defaults = defaultPhase5Config(context.platform);
  const file: Phase5ConfigFile = {
    workspace_roots: [...defaults.workspaceRoots],
    default_max_cycles: defaults.defaultMaxCycles,
    hard_max_cycles: defaults.hardMaxCycles,
    default_stale_after_s: defaults.defaultStaleAfterS,
  };
  try {
    writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (writeCause) {
    if ((writeCause as NodeJS.ErrnoException).code === 'EEXIST') return readConfig(context);
    fail(
      'The Phase 5 configuration file could not be created.',
      writeCause instanceof Error ? writeCause.message : 'Check the protected state root and retry init.',
    );
  }

  try {
    assertPathIsSafe(path, 'file', context.platform);
    context.security.harden(path, 'file');
    assertConfigFileSecure(context);
  } catch (cause) {
    if (cause instanceof SecurityError) throw cause;
    fail(
      'The newly created Phase 5 configuration file could not be protected.',
      cause instanceof Error ? cause.message : 'Correct the state-root permissions and retry init.',
    );
  }
  return readConfig(context);
}
