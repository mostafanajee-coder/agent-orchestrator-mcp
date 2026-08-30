import { readFileSync, realpathSync } from 'node:fs';
import { posix as posixPath, win32 as winPath } from 'node:path';

import { stateLayout } from './stateRoot.js';
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

function pathFor(platform: NodeJS.Platform): typeof winPath | typeof posixPath {
  return platform === 'win32' ? winPath : posixPath;
}

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
function dropboxInfoPaths(environment: CloudSyncEnvironment): readonly string[] {
  const profile = environment.profileDir.trim();
  if (profile === '') return [];
  if (!isUsableSyncCandidate(profile, environment.platform)) return [];

  // Use target-platform semantics explicitly. This keeps Windows discovery
  // correct in tests running on a POSIX host and prevents mixed separators.
  const path = pathFor(environment.platform);
  if (environment.platform === 'win32') {
    return [
      path.join(profile, 'AppData', 'Local', 'Dropbox', 'info.json'),
      path.join(profile, 'AppData', 'Roaming', 'Dropbox', 'info.json'),
    ];
  }
  return [path.join(profile, '.dropbox', 'info.json')];
}

/**
 * Reads Dropbox's own config to learn its real root, rather than guessing a name.
 *
 * The config location comes from the trusted profile directory, never from
 * LOCALAPPDATA or HOME.
 */
function dropboxRoots(environment: CloudSyncEnvironment): SyncRoot[] {
  const roots: SyncRoot[] = [];
  for (const infoPath of dropboxInfoPaths(environment)) {
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
      if (typeof accountPath === 'string') {
        const candidate = accountPath.trim();
        if (isUsableSyncCandidate(candidate, environment.platform)) {
          roots.push({ path: candidate, provider: `Dropbox (${account})` });
        }
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
      roots.push({ path: value.trim(), provider: candidate.provider });
    }
  }

  // Roots named inside Dropbox's config get the same treatment: the file is
  // trusted to locate, but its contents are still just discovery hints.
  for (const root of dropboxRoots(environment)) {
    roots.push(root);
  }

  return dedupeSyncRoots(roots, environment.platform);
}

function dedupeSyncRoots(roots: readonly SyncRoot[], platform: NodeJS.Platform): SyncRoot[] {
  const path = pathFor(platform);
  const seen = new Set<string>();
  const unique: SyncRoot[] = [];

  for (const root of roots) {
    const key = (platform === 'win32' ? path.resolve(root.path).toLowerCase() : path.resolve(root.path));
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(root);
  }

  return unique;
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

function failProtectedInsideSync(
  protectedPath: string,
  provider: string,
  syncPath: string,
  resolved: boolean,
): never {
  throw new SecurityError(
    resolved
      ? `The protected state path ${protectedPath} resolves inside a cloud-synchronised directory (${provider} at ${syncPath}).`
      : `The protected state path ${protectedPath} is inside a cloud-synchronised directory (${provider} at ${syncPath}).`,
    'Move the synchronised folder, or exclude the state root from synchronisation, so secrets are not copied off this machine.',
  );
}

function failSyncInsideProtected(
  protectedPath: string,
  provider: string,
  syncPath: string,
  resolved: boolean,
): never {
  throw new SecurityError(
    resolved
      ? `The cloud-synchronised directory (${provider} at ${syncPath}) resolves inside protected state path ${protectedPath}.`
      : `The cloud-synchronised directory (${provider} at ${syncPath}) is inside protected state path ${protectedPath}.`,
    'Move the synchronised folder outside the state root and its protected contents so secrets are not copied off this machine.',
  );
}

interface ProtectedStatePath {
  readonly path: string;
}

function protectedStatePaths(stateRoot: string, platform: NodeJS.Platform): readonly ProtectedStatePath[] {
  const layout = stateLayout(stateRoot, platform);
  return [
    { path: layout.root },
    { path: layout.secrets },
    { path: layout.data },
    { path: layout.artifacts },
    { path: layout.logs },
    { path: layout.leaseKey },
  ];
}

function assertLexicalContainment(
  protectedPath: ProtectedStatePath,
  syncRoot: SyncRoot,
  platform: NodeJS.Platform,
): void {
  if (isInside(protectedPath.path, syncRoot.path, platform)) {
    failProtectedInsideSync(protectedPath.path, syncRoot.provider, syncRoot.path, false);
  }
  if (isInside(syncRoot.path, protectedPath.path, platform)) {
    failSyncInsideProtected(protectedPath.path, syncRoot.provider, syncRoot.path, false);
  }
}

function assertResolvedContainment(
  syncRoot: SyncRoot,
  protectedRepresentations: readonly { readonly path: string; readonly resolved: boolean }[],
  syncRepresentations: readonly { readonly path: string; readonly resolved: boolean }[],
  platform: NodeJS.Platform,
): void {
  for (const protectedRepresentation of protectedRepresentations) {
    for (const syncRepresentation of syncRepresentations) {
      const resolved = protectedRepresentation.resolved || syncRepresentation.resolved;
      if (isInside(protectedRepresentation.path, syncRepresentation.path, platform)) {
        failProtectedInsideSync(
          protectedRepresentation.path,
          syncRoot.provider,
          syncRepresentation.path,
          resolved,
        );
      }
      if (isInside(syncRepresentation.path, protectedRepresentation.path, platform)) {
        failSyncInsideProtected(
          protectedRepresentation.path,
          syncRoot.provider,
          syncRepresentation.path,
          resolved,
        );
      }
    }
  }
}

/**
 * Refuses a dangerous relationship between cloud sync and protected state.
 *
 * The protected set includes the root, every state directory, and lease.key.
 * Two passes are intentional. The lexical pass works before init has created
 * anything and rejects a provider nested below protected state before any
 * real-path operation can follow it. The real-path pass runs once objects
 * exist and defeats redirection on either side of the relationship.
 *
 * Secrets must not be copied off the machine by a background sync client.
 */
export function assertStateRootNotSynced(
  stateRoot: string,
  environment: CloudSyncEnvironment,
): void {
  const platform = environment.platform;
  const resolve = environment.realPathIfPresent;
  const protectedPaths = protectedStatePaths(stateRoot, platform);
  const syncRoots = detectSyncRoots(environment);

  // This pass is intentionally first. It is usable before init has created
  // anything, and it rejects a hostile nested provider root before any
  // real-path operation can follow it.
  for (const protectedPath of protectedPaths) {
    for (const syncRoot of syncRoots) {
      assertLexicalContainment(protectedPath, syncRoot, platform);
    }
  }

  if (resolve === undefined || syncRoots.length === 0) return;

  const resolvedProtectedPaths = protectedPaths.map((protectedPath) => ({
    protectedPath,
    resolved: resolve(protectedPath.path),
  }));

  for (const syncRoot of syncRoots) {
    const resolvedSync = resolve(syncRoot.path);
    const syncRepresentations = [
      { path: syncRoot.path, resolved: false },
      ...(resolvedSync === undefined ? [] : [{ path: resolvedSync, resolved: true }]),
    ];

    for (const { protectedPath, resolved } of resolvedProtectedPaths) {
      const protectedRepresentations = [
        { path: protectedPath.path, resolved: false },
        ...(resolved === undefined ? [] : [{ path: resolved, resolved: true }]),
      ];
      assertResolvedContainment(
        syncRoot,
        protectedRepresentations,
        syncRepresentations,
        platform,
      );
    }
  }
}
