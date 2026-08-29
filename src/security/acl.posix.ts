import { chmodSync, lstatSync } from 'node:fs';

import { SecurityError } from '../errors.js';
import type { AclReport, PathKind, SecurityProvider } from './provider.js';

export const POSIX_DIRECTORY_MODE = 0o700;
export const POSIX_FILE_MODE = 0o600;

export function expectedMode(kind: PathKind): number {
  return kind === 'directory' ? POSIX_DIRECTORY_MODE : POSIX_FILE_MODE;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** POSIX enforcement: owner-only permission bits, owned by the current user. */
export class PosixSecurityProvider implements SecurityProvider {
  public readonly kind = 'posix';

  public subject(): string {
    const uid = currentUid();
    return uid === undefined ? 'current user' : `uid ${uid}`;
  }

  public describe(): string {
    return 'POSIX permissions: directories 0700, secret files 0600, owned by the current user';
  }

  public harden(path: string, kind: PathKind): void {
    try {
      chmodSync(path, expectedMode(kind));
    } catch {
      throw new SecurityError(
        `Failed to set owner-only permissions on ${path}.`,
        'Check that the path exists and is owned by the current user.',
      );
    }
  }

  public verify(path: string, kind: PathKind): AclReport {
    const wanted = expectedMode(kind);
    // lstat, not stat: report on the path itself rather than a link target.
    const stats = lstatSync(path);
    const actual = stats.mode & 0o777;
    const problems: string[] = [];

    if (stats.isSymbolicLink()) {
      problems.push('is a symbolic link, not a real directory or file');
    }

    if (actual !== wanted) {
      problems.push(
        `mode is 0${actual.toString(8).padStart(3, '0')}, expected 0${wanted.toString(8).padStart(3, '0')}`,
      );
    }

    const uid = currentUid();
    if (uid !== undefined && stats.uid !== uid) {
      problems.push(`owned by uid ${stats.uid}, expected uid ${uid}`);
    }

    return {
      path,
      kind,
      secure: problems.length === 0,
      problems,
      detail: `mode 0${actual.toString(8).padStart(3, '0')}, owner uid ${stats.uid}`,
    };
  }
}
