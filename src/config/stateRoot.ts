import { posix as posixPath, win32 as winPath } from 'node:path';

import { SecurityError } from '../errors.js';

/**
 * Directory name used under the user profile on Windows.
 *
 * Deliberately NOT under LocalAppData. A packaged (MSIX) process has
 * LocalAppData virtualized into `...\Packages\<id>\LocalCache\Local`, so a
 * packaged and an unpackaged process resolve the same logical path to
 * different physical stores -- measured on Windows 11, where the LocalAppData
 * state root created by a packaged process reported as absent from an
 * unpackaged one. That breaks the invariant that there is exactly one
 * orchestrator state store per user. The profile root sits outside the
 * virtualization boundary and was measured to resolve identically from both.
 *
 * The full location is `<OS-reported user profile>\.agent-orchestrator-mcp`,
 * typically `C:\Users\<user>\.agent-orchestrator-mcp`. That normally
 * corresponds to `%USERPROFILE%`, but the environment variable is descriptive
 * only and is never the trust source; see StateRootEnvironment.profileDir.
 */
export const WINDOWS_STATE_DIR = '.agent-orchestrator-mcp';

/** Directory name used under the XDG state directory on POSIX. */
export const POSIX_STATE_DIR = 'agent-orchestrator-mcp';

/** Path segments of the pre-Phase-1B Windows location, relative to the profile. */
export const LEGACY_WINDOWS_SEGMENTS = ['AppData', 'Local', 'AgentOrchestratorMCP'] as const;

/**
 * Path helpers for the *target* platform, not the running one.
 *
 * `node:path` follows host semantics, so `join` on Linux would build
 * `C:\Users\fixed/.agent-orchestrator-mcp` when modelling Windows. Every pure
 * path decision here selects win32 or posix explicitly, so a Linux CI runner
 * checking Windows rules produces genuine Windows paths.
 */
function pathFor(platform: NodeJS.Platform): typeof winPath | typeof posixPath {
  return platform === 'win32' ? winPath : posixPath;
}

export interface StateRootEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Partial<Record<string, string>>>;
  /**
   * The user's profile directory, supplied by the caller.
   *
   * On Windows this MUST come from OS user identity — `os.userInfo().homedir`
   * — and never from `os.homedir()`, which Node documents as consulting the
   * USERPROFILE environment variable first. Measured on Windows 11: with
   * `USERPROFILE=D:\attacker-profile`, `os.homedir()` returned
   * `D:\attacker-profile` while `os.userInfo().homedir` still returned
   * `C:\Users\kingm`. Feeding an env-derived value in here would let anyone who
   * can set that variable relocate the state root, and the secrets in it.
   *
   * Deliberately not named `homedir`, so substituting `os.homedir()` later
   * reads as the mistake it would be.
   */
  readonly profileDir: string;
}

/** Absolute paths of every directory and file the state root contains. */
export interface StateLayout {
  readonly root: string;
  readonly data: string;
  readonly database: string;
  readonly databaseWal: string;
  readonly databaseShm: string;
  readonly artifacts: string;
  readonly secrets: string;
  readonly logs: string;
  readonly configFile: string;
  readonly workersFile: string;
  readonly leaseKey: string;
  readonly authorizationStateFile: string;
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;
/** `\\?\` and `\\.\` — the Win32 device namespaces. */
const DEVICE_NAMESPACE = /^\\\\[?.]\\/;
/** Any other `\\server\share` form. */
const UNC_PATH = /^\\\\/;

/**
 * Absoluteness judged for the *given* platform, not the running one.
 *
 * `path.isAbsolute` follows the semantics of the host it runs on, so it
 * reports a Windows path as relative on Linux. Resolution must behave the same
 * on every machine, including a Linux CI runner checking Windows rules.
 */
export function isAbsoluteFor(value: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return WINDOWS_ABSOLUTE.test(value) || WINDOWS_UNC.test(value);
  return value.startsWith('/');
}

/**
 * Rejects a profile directory that cannot safely hold a private state root.
 *
 * V1 is a local orchestrator, so the Windows profile must be a normal
 * drive-qualified local path. A network or device-namespace profile is refused
 * rather than supported: the state root is the system of record and must not
 * live on a share.
 */
function assertUsableProfileDir(profileDir: string, platform: NodeJS.Platform): string {
  const profile = profileDir.trim();

  if (profile === '') {
    throw new SecurityError(
      'No user profile directory is available, so the state root cannot be resolved.',
      'Run from a normal user session.',
    );
  }

  // A drive or filesystem root is never a user profile, and putting a
  // protected state root there would apply an owner-only DACL to the volume.
  // Checked first so `C:\` reports the most specific reason.
  if (DRIVE_ROOT.test(profile) || profile === '/') {
    throw new SecurityError(
      `The user profile directory (${profile}) is a filesystem root, which cannot hold the state root.`,
      'Run from a normal user session with a real user profile.',
    );
  }

  if (platform === 'win32') {
    if (DEVICE_NAMESPACE.test(profile)) {
      throw new SecurityError(
        `The user profile directory (${profile}) uses the Win32 device namespace, which is not supported.`,
        'V1 requires a normal local profile such as C:\\Users\\<user>.',
      );
    }
    if (UNC_PATH.test(profile)) {
      throw new SecurityError(
        `The user profile directory (${profile}) is a network (UNC) path, which cannot hold the state root.`,
        'V1 is a local orchestrator and requires a local profile such as C:\\Users\\<user>.',
      );
    }
  }

  if (!isAbsoluteFor(profile, platform)) {
    throw new SecurityError(
      platform === 'win32'
        ? `The user profile directory (${profile}) is not an absolute Windows path, so the state root cannot be resolved.`
        : `The user profile directory (${profile}) is not an absolute path, so the state root cannot be resolved.`,
      'Run from a normal user session.',
    );
  }

  return profile;
}

/**
 * Resolves the single global state root.
 *
 * Windows: `<OS-reported user profile>\.agent-orchestrator-mcp`
 * POSIX:   `$XDG_STATE_HOME/agent-orchestrator-mcp`, falling back to
 *          `<profile>/.local/state/agent-orchestrator-mcp`.
 *
 * There is deliberately no override: the state root is not caller-selectable,
 * so no argument, environment variable, or config file can redirect secrets
 * to an attacker-chosen location.
 */
export function resolveStateRoot(environment: StateRootEnvironment): string {
  const path = pathFor(environment.platform);

  if (environment.platform === 'win32') {
    // Neither LocalAppData nor USERPROFILE is consulted: the root derives from
    // the OS-supplied profile directory the caller passes in.
    return path.join(assertUsableProfileDir(environment.profileDir, 'win32'), WINDOWS_STATE_DIR);
  }

  const xdgStateHome = environment.env['XDG_STATE_HOME'];
  // Per the XDG spec a relative XDG_STATE_HOME is invalid and must be ignored.
  if (
    xdgStateHome !== undefined &&
    xdgStateHome.trim() !== '' &&
    isAbsoluteFor(xdgStateHome, environment.platform)
  ) {
    return path.join(xdgStateHome, POSIX_STATE_DIR);
  }

  // POSIX semantics are unchanged from the approved design.
  return path.join(
    assertUsableProfileDir(environment.profileDir, environment.platform),
    '.local',
    'state',
    POSIX_STATE_DIR,
  );
}

/**
 * Locations a previous version of this tool may have used.
 *
 * Derived from the already-trusted profile directory, NOT from LocalAppData:
 * the legacy root is advisory only and has no reason to accept an
 * environment-controlled location. A poisoned `LOCALAPPDATA` such as
 * `\\attacker-server\share` must never become a path that doctor probes.
 *
 * Reported so an operator can clean up. Never read from, never migrated, and
 * never authoritative.
 */
export function legacyStateRoots(environment: StateRootEnvironment): readonly string[] {
  if (environment.platform !== 'win32') return [];

  let profile: string;
  try {
    profile = assertUsableProfileDir(environment.profileDir, 'win32');
  } catch {
    // An unusable profile means there is nothing trustworthy to report
    // against. Advisory detection stays silent rather than guessing.
    return [];
  }

  return [winPath.join(profile, ...LEGACY_WINDOWS_SEGMENTS)];
}

/** Derives every path inside the state root. Pure, for the given platform. */
export function stateLayout(root: string, platform: NodeJS.Platform): StateLayout {
  const path = pathFor(platform);
  return {
    root,
    data: path.join(root, 'data'),
    database: path.join(root, 'data', 'orchestrator.db'),
    databaseWal: path.join(root, 'data', 'orchestrator.db-wal'),
    databaseShm: path.join(root, 'data', 'orchestrator.db-shm'),
    artifacts: path.join(root, 'artifacts'),
    secrets: path.join(root, 'secrets'),
    logs: path.join(root, 'logs'),
    configFile: path.join(root, 'config.json'),
    workersFile: path.join(root, 'workers.json'),
    leaseKey: path.join(root, 'secrets', 'lease.key'),
    authorizationStateFile: path.join(root, 'authorization-state.v1.json'),
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
