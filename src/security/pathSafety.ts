import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { SecurityError } from '../errors.js';

export type PathShape = 'directory' | 'file';

/**
 * Proves a path is what it claims to be, and is not a redirection.
 *
 * Empirically verified on Windows 11 with Node 22:
 *
 * | object            | lstat.isSymbolicLink() | realpath === path |
 * | ----------------- | ---------------------- | ----------------- |
 * | real directory    | false                  | true              |
 * | junction          | **true**               | false             |
 * | real file         | false                  | true              |
 * | hard link         | false                  | true              |
 * | symbolic link     | **true**               | false             |
 *
 * So `lstat` catches symlinks and junctions, and the realpath comparison is an
 * independent second signal that also catches a redirected *parent*. Hard
 * links are invisible to both, which is why the link count is checked for the
 * secret: a hard link is a second name for the same bytes.
 */
export interface PathSafetyOptions {
  /** Reject a file with more than one name. Used for secret material. */
  readonly requireSingleLink?: boolean;
}

export function canonicalise(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.replace(/[\\/]+$/, '').toLowerCase() : path;
}

/** Resolves a path through the filesystem, following every link. */
export function realPathOf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return realpathSync(path);
  }
}

/**
 * Refuses a security-sensitive path that is a link, a junction, a reparse
 * point, or the wrong kind of object.
 *
 * Called before hardening and before inspecting secret material so that no
 * `icacls` or `chmod` is ever applied through a link to a target elsewhere.
 */
export function assertPathIsSafe(
  path: string,
  shape: PathShape,
  platform: NodeJS.Platform = process.platform,
  options: PathSafetyOptions = {},
): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new SecurityError(
      `${path} could not be inspected, so it cannot be trusted.`,
      'Check that the path exists and is reachable by the current user.',
    );
  }

  // lstat does not follow the link, so this catches symlinks and junctions
  // before anything is applied to whatever they point at.
  if (stats.isSymbolicLink()) {
    throw new SecurityError(
      `${path} is a link or junction, not a real ${shape}.`,
      'Refusing to apply or read protection through a redirection. Remove the link and run init again.',
    );
  }

  if (shape === 'directory' && !stats.isDirectory()) {
    throw new SecurityError(
      `${path} is expected to be a directory but is not.`,
      'Remove or rename the conflicting object and run init again.',
    );
  }
  if (shape === 'file' && !stats.isFile()) {
    throw new SecurityError(
      `${path} is expected to be a regular file but is not.`,
      'Remove or rename the conflicting object and run init again.',
    );
  }

  if (options.requireSingleLink === true && stats.nlink > 1) {
    throw new SecurityError(
      `${path} has ${String(stats.nlink)} hard links, so its contents are reachable under another name.`,
      'Delete the extra name, then delete the key and run init again to generate a fresh one.',
    );
  }

  // Independent second signal, resolved relative to the parent.
  //
  // Comparing the resolved path against the literal path would be wrong: an
  // ancestor may be legitimately redirected by the OS and not by an attacker.
  // What must hold is that THIS component introduces no new redirection: the
  // path must resolve to exactly its parent's real location plus its own name.
  //
  // This applies to EVERY protected path including the state root. There is no
  // package-specific bypass: the root lives under the user profile, outside
  // the LocalAppData virtualization boundary, and was measured to resolve
  // identically from packaged and unpackaged processes.
  const parent = dirname(path);
  const resolved = realPathOf(path);
  const expected = parent === path ? resolved : join(realPathOf(parent), basename(path));

  if (canonicalise(resolved, platform) !== canonicalise(expected, platform)) {
    throw new SecurityError(
      `${path} resolves to a different location (${resolved}) than its parent implies (${expected}).`,
      'A reparse point or link redirects this path. Refusing to protect or read it.',
    );
  }
}

/** Non-throwing form, for read-only reporting. */
export function inspectPathSafety(
  path: string,
  shape: PathShape,
  platform: NodeJS.Platform = process.platform,
  options: PathSafetyOptions = {},
): { safe: boolean; problem: string | undefined } {
  try {
    assertPathIsSafe(path, shape, platform, options);
    return { safe: true, problem: undefined };
  } catch (cause) {
    return { safe: false, problem: cause instanceof Error ? cause.message : 'path is unsafe' };
  }
}
