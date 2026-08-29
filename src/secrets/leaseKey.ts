import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

import { SecurityError } from '../errors.js';
import { assertPathIsSafe } from '../security/pathSafety.js';
import type { SecurityProvider } from '../security/provider.js';

/**
 * 256 bits, the key size HMAC-SHA256 is defined for.
 *
 * The V1 format is exactly this many raw bytes -- not a minimum. A file of any
 * other size is malformed and is refused rather than interpreted.
 */
export const LEASE_KEY_BYTES = 32;

export interface LeaseKeyStatus {
  readonly present: boolean;
  readonly secure: boolean;
  readonly sizeBytes: number | undefined;
  readonly problems: readonly string[];
}

function sizeProblem(sizeBytes: number): string | undefined {
  return sizeBytes === LEASE_KEY_BYTES
    ? undefined
    : `is ${String(sizeBytes)} bytes; the key must be exactly ${String(LEASE_KEY_BYTES)}`;
}

/**
 * Writes a buffer in full, looping until every byte is accepted.
 *
 * A single `writeSync` may legitimately write fewer bytes than requested, so
 * its return value is honoured rather than assumed.
 */
function writeFully(descriptor: number, data: Buffer): void {
  let written = 0;
  while (written < data.length) {
    const count = writeSync(descriptor, data, written, data.length - written);
    if (count <= 0) {
      throw new SecurityError(
        `The lease key could not be written in full (${String(written)} of ${String(data.length)} bytes).`,
        'The partial key was removed. Check free disk space and run init again.',
      );
    }
    written += count;
  }
}

/**
 * Proves an existing key is a real file and is protected, before anything
 * reads it.
 *
 * Order matters: path safety, then the DACL or mode, then the size. An unsafe
 * key is refused outright -- never read, never repaired in place.
 */
function assertExistingKeyIsSafe(path: string, security: SecurityProvider): void {
  assertPathIsSafe(path, 'file', process.platform, { requireSingleLink: true });

  const report = security.verify(path, 'file');
  if (!report.secure) {
    throw new SecurityError(
      `The lease key at ${path} is not protected: ${report.problems.join('; ')}.`,
      'Delete the key and run init again to generate a fresh one, or repair its permissions manually. It was not read.',
    );
  }

  // lstat rather than opening the file: the size is all that is needed, and
  // the secret is never opened for reading anywhere in this module.
  const problem = sizeProblem(lstatSync(path).size);
  if (problem !== undefined) {
    throw new SecurityError(
      `The lease key at ${path} ${problem}.`,
      'Delete the malformed key and run init again to generate a fresh one.',
    );
  }
}

export interface EnsureLeaseKeyResult {
  readonly created: boolean;
  readonly path: string;
}

/**
 * Creates the lease key once, then preserves it.
 *
 * The containing directory must already be hardened and verified: this
 * function never creates secret material inside an unprotected directory.
 * On any failure after creation the partial file is removed, so a truncated
 * or unprotected key is never left behind.
 */
export function ensureLeaseKey(path: string, security: SecurityProvider): EnsureLeaseKeyResult {
  if (existsSync(path)) {
    assertExistingKeyIsSafe(path, security);
    return { created: false, path };
  }

  let descriptor: number;
  try {
    // 'wx' fails if the path already exists, so a concurrent init cannot be
    // silently overwritten. The mode matters on POSIX; on Windows the file
    // inherits the already-hardened parent DACL.
    descriptor = openSync(path, 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      assertExistingKeyIsSafe(path, security);
      return { created: false, path };
    }
    throw cause;
  }

  try {
    writeFully(descriptor, randomBytes(LEASE_KEY_BYTES));
    fsyncSync(descriptor);

    // Independent confirmation, from the descriptor we just wrote, that the
    // file really is the exact expected size before it is trusted.
    const written = fstatSync(descriptor).size;
    if (written !== LEASE_KEY_BYTES) {
      throw new SecurityError(
        `The lease key was written as ${String(written)} bytes instead of ${String(LEASE_KEY_BYTES)}.`,
        'The partial key was removed. Run init again.',
      );
    }
    closeSync(descriptor);
  } catch (cause) {
    try {
      closeSync(descriptor);
    } catch {
      /* already closed */
    }
    removeQuietly(path);
    throw cause;
  }

  try {
    security.harden(path, 'file');
    assertPathIsSafe(path, 'file', process.platform, { requireSingleLink: true });
    const report = security.verify(path, 'file');
    if (!report.secure) {
      throw new SecurityError(
        `The newly created lease key at ${path} could not be protected: ${report.problems.join('; ')}.`,
        'The partial key was removed. Resolve the permission problem and run init again.',
      );
    }
  } catch (cause) {
    removeQuietly(path);
    throw cause;
  }

  return { created: true, path };
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Read-only inspection for doctor.
 *
 * Reports presence, path safety, protection, and size. It never reads the key
 * bytes, so the secret is never loaded, logged, or returned.
 */
export function inspectLeaseKey(path: string, security: SecurityProvider): LeaseKeyStatus {
  if (!existsSync(path)) {
    return { present: false, secure: false, sizeBytes: undefined, problems: ['the lease key is missing'] };
  }

  const problems: string[] = [];

  try {
    assertPathIsSafe(path, 'file', process.platform, { requireSingleLink: true });
  } catch (cause) {
    return {
      present: true,
      secure: false,
      sizeBytes: undefined,
      problems: [cause instanceof Error ? cause.message : 'the lease key path is unsafe'],
    };
  }

  try {
    problems.push(...security.verify(path, 'file').problems);
  } catch (cause) {
    problems.push(cause instanceof Error ? cause.message : 'protection could not be verified');
  }

  const sizeBytes = lstatSync(path).size;
  const problem = sizeProblem(sizeBytes);
  if (problem !== undefined) problems.push(problem);

  return { present: true, secure: problems.length === 0, sizeBytes, problems };
}
