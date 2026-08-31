import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { posix as posixPath, win32 as winPath } from 'node:path';

import { z } from 'zod/v4';

import type { CommandContext } from '../commands/context.js';
import { SecurityError } from '../errors.js';
import { assertPathIsSafe } from '../security/pathSafety.js';
import type { SqliteDatabase } from '../store/db.js';
import { assertRoleCapabilities, hasCapability, parseCapabilities } from '../authority/capabilities.js';
import type { StateLayout } from './stateRoot.js';

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;
const WINDOWS_DEVICE = /^\\\\[?.]\\/;
const POSIX_ABSOLUTE = /^\//;
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 4_096;
const MAX_ARG_BYTES = 1_024;
const MAX_ENV_NAME_BYTES = 128;
const MAX_WORKER_ID_BYTES = 64;
const MAX_WORKERS = 64;
const MAX_ARGS = 32;
const MAX_ENV_NAMES = 64;
const MAX_TIMEOUT_MS = 900_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 256;

export const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const WorkerDefinitionSchema = z.object({
  worker_id: z.string().regex(WORKER_ID_PATTERN).max(MAX_WORKER_ID_BYTES),
  actor_id: z.string().regex(WORKER_ID_PATTERN).max(MAX_WORKER_ID_BYTES),
  enabled: z.boolean(),
  adapter: z.literal('process'),
  delivery: z.enum(['pipe', 'mcp_pull']),
  executable: z.string().trim().min(1).max(MAX_PATH_BYTES),
  argv_template: z.array(z.string().max(MAX_ARG_BYTES)).max(MAX_ARGS),
  cwd_policy: z.literal('job_workspace'),
  environment_allowlist: z.array(
    z.string().regex(ENVIRONMENT_NAME_PATTERN).max(MAX_ENV_NAME_BYTES),
  ).max(MAX_ENV_NAMES),
  default_timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS),
  hard_timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS),
  max_output_bytes: z.number().int().min(1).max(MAX_OUTPUT_BYTES),
  max_messages: z.number().int().min(1).max(MAX_MESSAGES),
}).strict();

export const WorkerRegistrySchema = z.object({
  version: z.literal(1),
  workers: z.array(WorkerDefinitionSchema).min(1).max(MAX_WORKERS),
}).strict();

export type WorkerDefinitionFile = z.infer<typeof WorkerDefinitionSchema>;
export type WorkerRegistryFile = z.infer<typeof WorkerRegistrySchema>;

export interface Phase6WorkerRegistry {
  readonly version: 1;
  readonly workers: readonly WorkerDefinitionFile[];
}

export function defaultPhase6WorkerRegistry(platform: NodeJS.Platform): Phase6WorkerRegistry {
  return {
    version: 1,
    workers: [{
      worker_id: 'local-worker',
      actor_id: 'worker-local',
      enabled: false,
      adapter: 'process',
      delivery: 'pipe',
      executable: platform === 'win32' ? 'C:\\AgentTools\\local-worker.exe' : '/usr/local/bin/local-worker',
      argv_template: [],
      cwd_policy: 'job_workspace',
      environment_allowlist: [],
      default_timeout_ms: 300_000,
      hard_timeout_ms: 900_000,
      max_output_bytes: 4 * 1024 * 1024,
      max_messages: 256,
    }],
  };
}

function fail(message: string, remedy = 'Edit the protected workers.json file and retry.'): never {
  throw new SecurityError(message, remedy);
}

function pathApi(platform: NodeJS.Platform): typeof winPath | typeof posixPath {
  return platform === 'win32' ? winPath : posixPath;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validateExecutablePath(value: string, platform: NodeJS.Platform): void {
  if (/[\0\r\n]/.test(value) || byteLength(value) > MAX_PATH_BYTES) {
    fail('A worker executable path is invalid or exceeds its bound.');
  }
  const path = pathApi(platform);
  if (platform === 'win32') {
    if (!WINDOWS_ABSOLUTE.test(value) || WINDOWS_UNC.test(value) || WINDOWS_DEVICE.test(value)) {
      fail('A worker executable must be a local absolute Windows path.');
    }
  } else if (!POSIX_ABSOLUTE.test(value)) {
    fail('A worker executable must be an absolute POSIX path.');
  }
  if (value.split(/[\\/]/).some((segment) => segment === '..')) {
    fail('A worker executable path must not contain traversal.');
  }
  if (path.parse(value).root === value || path.normalize(value) === path.parse(value).root) {
    fail('A worker executable path cannot be a filesystem root.');
  }
}

function validateCrossFields(registry: WorkerRegistryFile, platform: NodeJS.Platform): void {
  const workerIds = new Set<string>();
  const actorIds = new Set<string>();
  for (const worker of registry.workers) {
    if (byteLength(worker.worker_id) > MAX_WORKER_ID_BYTES || byteLength(worker.actor_id) > MAX_WORKER_ID_BYTES) {
      fail(`Worker ${worker.worker_id} has an oversized identity.`);
    }
    if (workerIds.has(worker.worker_id)) fail('workers.json contains duplicate worker_id values.');
    if (actorIds.has(worker.actor_id)) fail('workers.json contains duplicate actor_id values.');
    workerIds.add(worker.worker_id);
    actorIds.add(worker.actor_id);

    if (worker.default_timeout_ms > worker.hard_timeout_ms) {
      fail(`Worker ${worker.worker_id} has a default timeout above its hard timeout.`);
    }
    if (worker.max_output_bytes > MAX_OUTPUT_BYTES || worker.max_messages > MAX_MESSAGES) {
      fail(`Worker ${worker.worker_id} exceeds the global protocol bounds.`);
    }
    const envNames = new Set<string>();
    for (const name of worker.environment_allowlist) {
      if (envNames.has(name)) fail(`Worker ${worker.worker_id} contains duplicate environment names.`);
      envNames.add(name);
      if (byteLength(name) > MAX_ENV_NAME_BYTES) {
        fail(`Worker ${worker.worker_id} contains an oversized environment name.`);
      }
    }
    for (const argument of worker.argv_template) {
      if (byteLength(argument) > MAX_ARG_BYTES) {
        fail(`Worker ${worker.worker_id} contains an oversized argv template argument.`);
      }
    }
    if (byteLength(worker.executable) > MAX_PATH_BYTES) {
      fail(`Worker ${worker.worker_id} has an oversized executable path.`);
    }
    validateExecutablePath(worker.executable, platform);
  }
}

function validateEnabledExecutables(registry: WorkerRegistryFile, platform: NodeJS.Platform): void {
  for (const worker of registry.workers) {
    if (!worker.enabled) continue;
    let stats;
    try {
      assertPathIsSafe(worker.executable, 'file', platform);
      stats = lstatSync(worker.executable);
    } catch {
      fail(`Enabled worker ${worker.worker_id} has an unavailable executable.`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()
      || (platform !== 'win32' && (stats.mode & 0o111) === 0)) {
      fail(`Enabled worker ${worker.worker_id} executable is not a regular file.`);
    }
  }
}

function parseRegistry(raw: string, platform: NodeJS.Platform): Phase6WorkerRegistry {
  if (byteLength(raw) > MAX_REGISTRY_BYTES) fail('workers.json exceeds the 256 KiB bound.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('workers.json is not valid JSON.');
  }
  const result = WorkerRegistrySchema.safeParse(parsed);
  if (!result.success) fail('workers.json does not match the strict Phase 6 registry schema.');
  validateCrossFields(result.data, platform);
  validateEnabledExecutables(result.data, platform);
  return result.data;
}

function registryPath(layout: StateLayout): string {
  return layout.workersFile;
}

function assertRegistrySecure(context: CommandContext): void {
  const path = registryPath(context.layout);
  try {
    assertPathIsSafe(path, 'file', context.platform);
    const report = context.security.verify(path, 'file');
    if (!report.secure) {
      fail(
        'The Phase 6 worker registry is not protected: ' + report.problems.join('; ') + '.',
        'Protect workers.json using the approved state-root security model and retry.',
      );
    }
  } catch (cause) {
    if (cause instanceof SecurityError) throw cause;
    fail(
      'The Phase 6 worker registry could not be verified.',
      cause instanceof Error ? cause.message : 'Inspect workers.json and retry.',
    );
  }
}

/** Loads the strict, protected worker registry before transport exposure. */
export function loadPhase6WorkerRegistry(context: CommandContext): Phase6WorkerRegistry {
  const path = registryPath(context.layout);
  try {
    lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      fail(
        'The Phase 6 worker registry is missing.',
        'Create the protected workers.json file before serving Phase 6.',
      );
    }
    fail(
      'The Phase 6 worker registry could not be inspected.',
      cause instanceof Error ? cause.message : 'Inspect workers.json and retry.',
    );
  }
  assertRegistrySecure(context);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    fail(
      'The Phase 6 worker registry could not be read.',
      cause instanceof Error ? cause.message : 'Inspect workers.json and retry.',
    );
  }
  return parseRegistry(raw, context.platform);
}

/** Creates a disabled, protected starter registry on the explicit init path. */
export function ensurePhase6WorkerRegistry(context: CommandContext): Phase6WorkerRegistry {
  const path = registryPath(context.layout);
  try {
    lstatSync(path);
    return loadPhase6WorkerRegistry(context);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (cause instanceof SecurityError) throw cause;
      fail(
        'The Phase 6 worker registry could not be inspected.',
        cause instanceof Error ? cause.message : 'Inspect workers.json and retry.',
      );
    }
  }

  const defaults = defaultPhase6WorkerRegistry(context.platform);
  try {
    writeFileSync(path, JSON.stringify(defaults, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (writeCause) {
    if ((writeCause as NodeJS.ErrnoException).code === 'EEXIST') return loadPhase6WorkerRegistry(context);
    fail(
      'The Phase 6 worker registry could not be created.',
      writeCause instanceof Error ? writeCause.message : 'Check the protected state root and retry init.',
    );
  }
  try {
    assertPathIsSafe(path, 'file', context.platform);
    context.security.harden(path, 'file');
    assertRegistrySecure(context);
  } catch (cause) {
    if (cause instanceof SecurityError) throw cause;
    fail(
      'The newly created Phase 6 worker registry could not be protected.',
      cause instanceof Error ? cause.message : 'Correct the state-root permissions and retry init.',
    );
  }
  return defaults;
}

/** Validates registry actor bindings against the already verified authority DB. */
export function validatePhase6WorkerActors(
  db: SqliteDatabase,
  registry: Phase6WorkerRegistry,
): void {
  const rows = db.prepare(
    'SELECT actor_id, role, disabled, capabilities_json FROM actors ORDER BY actor_id',
  ).all() as Array<Record<string, unknown>>;
  const actors = new Map(rows.map((row) => [String(row['actor_id']), row]));
  for (const worker of registry.workers) {
    if (!worker.enabled) continue;
    const actor = actors.get(worker.actor_id);
    if (actor === undefined || actor['role'] !== 'worker' || Number(actor['disabled']) !== 0) {
      fail(`Worker ${worker.worker_id} is not bound to an enabled worker actor.`);
    }
    if (typeof actor['capabilities_json'] !== 'string') {
      fail(`Worker ${worker.worker_id} has malformed actor capabilities.`);
    }
    let capabilities: ReturnType<typeof parseCapabilities>;
    try {
      capabilities = parseCapabilities(actor['capabilities_json']);
      assertRoleCapabilities('worker', capabilities);
    } catch {
      fail(`Worker ${worker.worker_id} has incompatible actor capabilities.`);
    }
    if (worker.delivery === 'mcp_pull' && !hasCapability(capabilities, 'work:report')) {
      fail(`Worker ${worker.worker_id} is missing the work:report capability.`);
    }
  }
}

/** Test-visible parser for deterministic registry validation without filesystem access. */
export function parsePhase6WorkerRegistry(
  raw: string,
  platform: NodeJS.Platform,
): Phase6WorkerRegistry {
  return parseRegistry(raw, platform);
}
