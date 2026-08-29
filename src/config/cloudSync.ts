import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { SecurityError } from '../errors.js';

/** A directory tree that a cloud provider synchronises off this machine. */
export interface SyncRoot {
  readonly path: string;
  readonly provider: string;
}

export interface CloudSyncEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Partial<Record<string, string>>>;
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

/**
 * Environment variables that hold a real sync-root path.
 *
 * These are set by the sync clients themselves and carry the actual path, so
 * detection does not depend on a folder being named "OneDrive" in English.
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

/** Reads Dropbox's own config to learn its real root, rather than guessing a name. */
function dropboxRoots(environment: CloudSyncEnvironment): SyncRoot[] {
  const localAppData = environment.env['LOCALAPPDATA'];
  const home = environment.env['HOME'];
  const infoPaths: string[] = [];
  if (localAppData !== undefined && localAppData !== '') {
    infoPaths.push(join(localAppData, 'Dropbox', 'info.json'));
  }
  if (home !== undefined && home !== '') {
    infoPaths.push(join(home, '.dropbox', 'info.json'));
  }

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
    if (value !== undefined && value.trim() !== '') {
      roots.push({ path: value, provider: candidate.provider });
    }
  }
  roots.push(...dropboxRoots(environment));
  return roots;
}

/** True when `child` is `parent` or sits underneath it. */
export function isInside(child: string, parent: string, caseInsensitive: boolean): boolean {
  const normalise = (value: string): string => {
    const resolved = resolve(value);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  const rel = relative(normalise(parent), normalise(child));
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
  const caseInsensitive = environment.platform === 'win32';
  const resolve = environment.realPathIfPresent;
  const resolvedRoot = resolve === undefined ? undefined : resolve(stateRoot);

  for (const syncRoot of detectSyncRoots(environment)) {
    if (isInside(stateRoot, syncRoot.path, caseInsensitive)) {
      fail(stateRoot, syncRoot.provider, syncRoot.path, false);
    }

    if (resolvedRoot === undefined) continue;

    // Compare resolved against declared, and resolved against resolved, so
    // redirection on either side is caught.
    if (isInside(resolvedRoot, syncRoot.path, caseInsensitive)) {
      fail(resolvedRoot, syncRoot.provider, syncRoot.path, true);
    }

    const resolvedSync = resolve === undefined ? undefined : resolve(syncRoot.path);
    if (resolvedSync !== undefined && isInside(resolvedRoot, resolvedSync, caseInsensitive)) {
      fail(resolvedRoot, syncRoot.provider, resolvedSync, true);
    }
  }
}
