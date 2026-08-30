import { readFileSync, realpathSync } from 'node:fs';
import { join, posix as posixPath, win32 as winPath } from 'node:path';

import { SecurityError } from '../errors.js';

/** A directory tree that a cloud provider synchronises off this machine. */
export interface SyncRoot {
  readonly path: string;
  readonly provider: string;
}

export interface CloudSyncEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Partial<Record<string, string>>>;
  /**
   * The trusted OS-reported profile directory, as used for the state root.
   *
   * Sync-client config files are located from this rather than from
   * LOCALAPPDATA or HOME, so a poisoned variable cannot point a `readFileSync`
   * at `\\attacker-server\share\Dropbox\info.json`.
   */
  readonly profileDir: string;
  /** Reads a file, returning undefined when it does not exist or is unreadable. */
  readonly readFileIfPresent: (path: string) => string | undefined;
  /**
   * Resolves a path through the filesystem, following links.
   *
   * Injected so redirection can be modelled in tests. Returns undefined when
   * the path does not exist yet, which is the normal case before init.
   */
  readonly realPathIfPresent?: (path: string) => string | undefined;
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;
/** `\\?\` and `\\.\` — the Win32 device namespaces. */
const DEVICE_NAMESPACE = /^\\\\[?.]\\/;
/** Any other `\\server\share` form. */
const UNC_PATH = /^\\\\/;

/**
 * Environment variables that hold a real sync-root path.
 *
 * These are set by the sync clients themselves and carry the actual path, so
 * detection does not depend on a folder being named "OneDrive" in English.
 * The values are still only hints, and are validated before use.
 */
const ENV_SYNC_ROOTS: readonly { readonly variable: string; readonly provider: string }[] = [
  { variable: 'OneDrive', provider: 'OneDrive' },
  { variable: 'OneDriveConsumer', provider: 'OneDrive (personal)' },
  { variable: 'OneDriveCommercial', provider: 'OneDrive for Business' },
];

export function readFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * A discovery hint that may reach the filesystem must first look like a normal
 * local path.
 *
 * On Windows, environment-published sync roots are best-effort hints, so an
 * unusable one is ignored rather than failing the run — but it must never be
 * handed to `realpath` or `readFile`. UNC and device-namespace paths would
 * turn advisory discovery into attacker-directed I/O, including network I/O.
 *
 * POSIX stays conventional: a pathname alone cannot tell you whether a mount
 * is local, so there is nothing meaningful to validate.
 */
export function isUsableSyncCandidate(value: string, platform: NodeJS.Platform): boolean {
  const candidate = value.trim();
  if (candidate === '') return false;
  if (platform !== 'win32') return candidate.startsWith('/');

  if (DEVICE_NAMESPACE.test(candidate)) return false;
  if (UNC_PATH.test(candidate)) return false;
  // `C:relative` is drive-relative, not absolute.
  if (!WINDOWS_ABSOLUTE.test(candidate)) return false;
  // A whole volume is never a real sync root.
  if (DRIVE_ROOT.test(candidate)) return false;
  return true;
}

/** Where each platform keeps Dropbox's config, relative to the trusted profile. */
function dropboxInfoPath(environment: CloudSyncEnvironment): string | undefined {
  const profile = environment.profileDir.trim();
  if (profile === '') return undefined;
  if (!isUsableSyncCandidate(profile, environment.platform)) return undefined;

  // `join` here is intentionally the host's: this builds a path that is then
  // opened on the running machine, so host semantics are the correct ones.
  return environment.platform === 'win32'
    ? join(profile, 'AppData', 'Local', 'Dropbox', 'info.json')
    : join(profile, '.dropbox', 'info.json');
}

/**
 * Reads Dropbox's own config to learn its real root, rather than guessing a name.
 *
 * The config location comes from the trusted profile directory, never from
 * LOCALAPPDATA or HOME.
 */
function dropboxRoots(environment: CloudSyncEnvironment): SyncRoot[] {
  const infoPath = dropboxInfoPath(environment);
  const infoPaths = infoPath === undefined ? [] : [infoPath];

  const roots: SyncRoot[] = [];
  for (const infoPath of infoPaths) {
    const raw = environment.readFileIfPresent(infoPath);
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    for (const [account, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      if (!('path' in value)) continue;
      const accountPath = (value as { path: unknown }).path;
      if (typeof accountPath === 'string' && accountPath !== '') {
        roots.push({ path: accountPath, provider: `Dropbox (${account})` });
      }
    }
  }
  return roots;
}

/**
 * Collects known cloud-sync roots from the environment.
 *
 * This never scans the disk: it reads environment variables the sync clients
 * publish, plus Dropbox's own `info.json` at its documented location.
 * Detection is therefore best-effort — an unknown provider will not be caught.
 */
export function detectSyncRoots(environment: CloudSyncEnvironment): SyncRoot[] {
  const roots: SyncRoot[] = [];

  for (const candidate of ENV_SYNC_ROOTS) {
    const value = environment.env[candidate.variable];
    // Validated before it can reach realpath: an unusable hint is dropped, not
    // probed, and does not fail an otherwise secure state root.
    if (value !== undefined && isUsableSyncCandidate(value, environment.platform)) {
      roots.push({ path: value, provider: candidate.provider });
    }
  }

  // Roots named inside Dropbox's config get the same treatment: the file is
  // trusted to locate, but its contents are still just discovery hints.
  for (const root of dropboxRoots(environment)) {
    if (isUsableSyncCandidate(root.path, environment.platform)) roots.push(root);
  }

  return roots;
}

/**
 * True when `child` is `parent` or sits underneath it, judged for the *target*
 * platform.
 *
 * Uses `path.win32` / `path.posix` explicitly rather than the host's `path`,
 * so a Linux runner comparing Windows paths still applies Windows separator
 * and case rules. Inputs are absolute in every caller, so `resolve` never
 * falls back to the host working directory.
 */
export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? winPath : posixPath;
  const caseInsensitive = platform === 'win32';

  const normalise = (value: string): string => {
    const resolved = path.resolve(value);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };

  const rel = path.relative(normalise(parent), normalise(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel);
}

export function realPathIfPresent(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  }
}

function fail(stateRoot: string, provider: string, syncPath: string, resolved: boolean): never {
  throw new SecurityError(
    resolved
      ? `The state root ${stateRoot} resolves inside a cloud-synchronised directory (${provider} at ${syncPath}).`
      : `The state root ${stateRoot} is inside a cloud-synchronised directory (${provider} at ${syncPath}).`,
    'Move the synchronised folder, or exclude the state root from synchronisation, so secrets are not copied off this machine.',
  );
}

/**
 * Refuses a state root that sits inside a cloud-synchronised directory.
 *
 * Two passes. The lexical pass works before the state root exists, so init can
 * refuse a bad location without creating anything. The real-path pass runs
 * once the paths exist and defeats redirection: a junction or symlink whose
 * name looks safe but whose target is inside a sync root is caught here.
 *
 * Secrets must not be copied off the machine by a background sync client.
 */
export function assertStateRootNotSynced(
  stateRoot: string,
  environment: CloudSyncEnvironment,
): void {
  const platform = environment.platform;
  const resolve = environment.realPathIfPresent;
  const resolvedRoot = resolve === undefined ? undefined : resolve(stateRoot);

  for (const syncRoot of detectSyncRoots(environment)) {
    if (isInside(stateRoot, syncRoot.path, platform)) {
      fail(stateRoot, syncRoot.provider, syncRoot.path, false);
    }

    if (resolvedRoot === undefined) continue;

    // Compare resolved against declared, and resolved against resolved, so
    // redirection on either side is caught.
    if (isInside(resolvedRoot, syncRoot.path, platform)) {
      fail(resolvedRoot, syncRoot.provider, syncRoot.path, true);
    }

    const resolvedSync = resolve === undefined ? undefined : resolve(syncRoot.path);
    if (resolvedSync !== undefined && isInside(resolvedRoot, resolvedSync, platform)) {
      fail(resolvedRoot, syncRoot.provider, resolvedSync, true);
    }
  }
}
