import { isAbsolute, join } from 'node:path';

import { SecurityError } from '../errors.js';

/** Directory name used under %LOCALAPPDATA% on Windows. */
export const WINDOWS_STATE_DIR = 'AgentOrchestratorMCP';
/** Directory name used under the XDG state directory on POSIX. */
export const POSIX_STATE_DIR = 'agent-orchestrator-mcp';

/**
 * The environment inputs state-root resolution depends on.
 *
 * Passed in rather than read from `process` so resolution stays a pure
 * function and can be tested for every platform from any platform.
 */
export interface StateRootEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Partial<Record<string, string>>>;
  readonly homedir: string;
}

/** Absolute paths of every directory and file the state root contains. */
export interface StateLayout {
  readonly root: string;
  readonly data: string;
  readonly artifacts: string;
  readonly secrets: string;
  readonly logs: string;
  readonly leaseKey: string;
}

/**
 * Resolves the single global state root.
 *
 * Windows: `%LOCALAPPDATA%\AgentOrchestratorMCP`
 * POSIX:   `$XDG_STATE_HOME/agent-orchestrator-mcp`, falling back to
 *          `~/.local/state/agent-orchestrator-mcp`.
 *
 * There is deliberately no override: the state root is not caller-selectable,
 * so no argument, environment variable, or config file can redirect secrets
 * to an attacker-chosen location.
 */
export function resolveStateRoot(environment: StateRootEnvironment): string {
  if (environment.platform === 'win32') {
    const localAppData = environment.env['LOCALAPPDATA'];
    if (localAppData === undefined || localAppData.trim() === '') {
      throw new SecurityError(
        'LOCALAPPDATA is not set, so the state root cannot be resolved.',
        'Run from a normal Windows user session where LOCALAPPDATA is defined.',
      );
    }
    return join(localAppData, WINDOWS_STATE_DIR);
  }

  const xdgStateHome = environment.env['XDG_STATE_HOME'];
  // Per the XDG spec a relative XDG_STATE_HOME is invalid and must be ignored.
  if (xdgStateHome !== undefined && xdgStateHome.trim() !== '' && isAbsolute(xdgStateHome)) {
    return join(xdgStateHome, POSIX_STATE_DIR);
  }

  if (environment.homedir.trim() === '') {
    throw new SecurityError(
      'No home directory is available, so the state root cannot be resolved.',
      'Set XDG_STATE_HOME to an absolute path.',
    );
  }

  return join(environment.homedir, '.local', 'state', POSIX_STATE_DIR);
}

/** Derives every path inside the state root. Pure. */
export function stateLayout(root: string): StateLayout {
  return {
    root,
    data: join(root, 'data'),
    artifacts: join(root, 'artifacts'),
    secrets: join(root, 'secrets'),
    logs: join(root, 'logs'),
    leaseKey: join(root, 'secrets', 'lease.key'),
  };
}

/**
 * Directories in creation and hardening order.
 *
 * `secrets` is created and hardened before the lease key is written into it,
 * so secret material never exists inside a broadly inherited directory.
 */
export function stateDirectories(layout: StateLayout): readonly string[] {
  return [layout.root, layout.secrets, layout.data, layout.artifacts, layout.logs];
}
