import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { SecurityError } from '../errors.js';
import { assertPathIsSafe } from '../security/pathSafety.js';
import type { SecurityProvider } from '../security/provider.js';

export const AUTHORIZATION_STATE_VERSION = 1 as const;
export const AUTHORIZATION_STATE_MAX_BYTES = 4_096;
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5_000;
export const AUTHORIZATION_EPOCH_BYTES = 32;
export const AUTHORIZATION_EPOCH_HEX_LENGTH = AUTHORIZATION_EPOCH_BYTES * 2;

const EPOCH_PATTERN = /^[0-9a-f]{64}$/;
const REQUIRED_FIELDS = ['authorization_epoch', 'clock_high_water_ms', 'version'] as const;

export type AuthorizationReadiness =
  | 'UNINITIALIZED'
  | 'READY'
  | 'INVALID'
  | 'CLOCK_ROLLBACK';

export interface AuthorizationStateDocument {
  readonly version: typeof AUTHORIZATION_STATE_VERSION;
  readonly authorization_epoch: string;
  readonly clock_high_water_ms: number;
}

export interface AuthorizationStateStatus {
  readonly readiness: AuthorizationReadiness;
  readonly epochFingerprint: string | null;
  readonly clockHighWaterMs: number | null;
  readonly effectiveNowMs: number | null;
  readonly detail: string;
}

interface StateFileStats {
  readonly size: number;
  readonly nlink: number;
}

export interface AuthorizationStateFileSystem {
  readonly exists: (path: string) => boolean;
  readonly lstat: (path: string) => StateFileStats;
  readonly read: (path: string) => string;
  readonly open: (path: string, flags: string, mode?: number) => number;
  readonly write: (descriptor: number, data: Buffer, offset: number, length: number) => number;
  readonly fsync: (descriptor: number) => void;
  readonly close: (descriptor: number) => void;
  readonly rename: (source: string, target: string) => void;
  readonly unlink: (path: string) => void;
}

const NODE_FILE_SYSTEM: AuthorizationStateFileSystem = {
  exists: existsSync,
  lstat: (path): StateFileStats => {
    const stats = lstatSync(path);
    return { size: stats.size, nlink: stats.nlink };
  },
  read: (path): string => readFileSync(path, 'utf8'),
  open: (path, flags, mode): number => mode === undefined
    ? openSync(path, flags)
    : openSync(path, flags, mode),
  write: writeSync,
  fsync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  unlink: unlinkSync,
};

export interface AuthorizationStateOptions {
  readonly path: string;
  readonly security: SecurityProvider;
  readonly platform?: NodeJS.Platform;
  readonly clock?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly fileSystem?: AuthorizationStateFileSystem;
}

export interface AuthorizationStateWriteOptions extends AuthorizationStateOptions {
  readonly replace: boolean;
}

export type AuthorizationStateFailurePhase = 'pre-commit' | 'post-commit';

/** A bounded classification for operator-safe persistence failure handling. */
export class AuthorizationStatePersistenceError extends SecurityError {
  public constructor(
    public readonly phase: AuthorizationStateFailurePhase,
    message: string,
    remedy?: string,
  ) {
    super(message, remedy);
  }
}

function platformOf(options: AuthorizationStateOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function fileSystemOf(options: AuthorizationStateOptions): AuthorizationStateFileSystem {
  return options.fileSystem ?? NODE_FILE_SYSTEM;
}

function invalidStatus(detail: string): AuthorizationStateStatus {
  return {
    readiness: 'INVALID',
    epochFingerprint: null,
    clockHighWaterMs: null,
    effectiveNowMs: null,
    detail,
  };
}

function stateFingerprint(epoch: string): string {
  return createHash('sha256').update(epoch, 'utf8').digest('hex');
}

function validNow(nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0;
}

/** Parses the exact v1 document without coercion or defaulting. */
export function parseAuthorizationState(value: unknown): AuthorizationStateDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SecurityError(
      'The authorization state document is not an object.',
      'Run the explicit local authority-state recovery operation; no automatic repair was performed.',
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...REQUIRED_FIELDS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new SecurityError(
      'The authorization state document has missing or unexpected fields.',
      'Use the explicit local authority-state recovery operation; no automatic repair was performed.',
    );
  }

  if (record.version !== AUTHORIZATION_STATE_VERSION) {
    throw new SecurityError(
      'The authorization state document version is unsupported.',
      'Upgrade through an approved state-file version and do not silently reinterpret this document.',
    );
  }

  if (typeof record.authorization_epoch !== 'string' || !EPOCH_PATTERN.test(record.authorization_epoch)) {
    throw new SecurityError(
      'The authorization epoch is malformed.',
      'Generate a fresh epoch through the explicit local authority-state operation.',
    );
  }

  if (
    typeof record.clock_high_water_ms !== 'number'
    || !Number.isSafeInteger(record.clock_high_water_ms)
    || record.clock_high_water_ms < 0
  ) {
    throw new SecurityError(
      'The authorization clock high-water value is malformed.',
      'Use the explicit local authority-state recovery operation; no automatic repair was performed.',
    );
  }

  return {
    version: AUTHORIZATION_STATE_VERSION,
    authorization_epoch: record.authorization_epoch,
    clock_high_water_ms: record.clock_high_water_ms,
  };
}

export function serializeAuthorizationState(document: AuthorizationStateDocument): string {
  const parsed = parseAuthorizationState(document);
  return JSON.stringify({
    version: parsed.version,
    authorization_epoch: parsed.authorization_epoch,
    clock_high_water_ms: parsed.clock_high_water_ms,
  }) + '\n';
}

export function createAuthorizationStateDocument(
  nowMs: number,
  bytes: (size: number) => Buffer = randomBytes,
): AuthorizationStateDocument {
  if (!validNow(nowMs)) {
    throw new SecurityError(
      'The system clock is invalid, so authorization state cannot be initialized.',
      'Run from a normal session with a valid wall clock. No state was created.',
    );
  }
  const epoch = bytes(AUTHORIZATION_EPOCH_BYTES);
  if (!Buffer.isBuffer(epoch) || epoch.byteLength !== AUTHORIZATION_EPOCH_BYTES) {
    throw new SecurityError(
      'The authorization epoch generator returned invalid material.',
      'Use the approved AOM cryptographic random source. No state was created.',
    );
  }
  return {
    version: AUTHORIZATION_STATE_VERSION,
    authorization_epoch: epoch.toString('hex'),
    clock_high_water_ms: nowMs,
  };
}

function safeStats(fileSystem: AuthorizationStateFileSystem, path: string): StateFileStats | undefined {
  try {
    return fileSystem.lstat(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw cause;
  }
}

function stateDocumentFromFile(
  options: AuthorizationStateOptions,
): AuthorizationStateDocument {
  const fileSystem = fileSystemOf(options);
  const stats = safeStats(fileSystem, options.path);
  if (stats === undefined) {
    throw new SecurityError(
      'The authorization state file is missing.',
      'Run the explicit local authority-state init or recovery operation; no automatic state was created.',
    );
  }
  if (stats.size > AUTHORIZATION_STATE_MAX_BYTES) {
    throw new SecurityError(
      'The authorization state file exceeds its maximum size.',
      'Use the explicit local authority-state recovery operation; no automatic repair was performed.',
    );
  }

  assertPathIsSafe(options.path, 'file', platformOf(options), { requireSingleLink: true });
  const security = options.security.verify(options.path, 'file');
  if (!security.secure) {
    throw new SecurityError(
      'The authorization state file is not protected by the required owner-only policy.',
      'Repair the state-file protection through the approved local operation; no state was repaired automatically.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileSystem.read(options.path)) as unknown;
  } catch {
    throw new SecurityError(
      'The authorization state file is not valid JSON.',
      'Use the explicit local authority-state recovery operation; no automatic repair was performed.',
    );
  }
  return parseAuthorizationState(parsed);
}

export function inspectAuthorizationState(
  options: AuthorizationStateOptions,
  nowMs?: number,
): AuthorizationStateStatus {
  try {
    const fileSystem = fileSystemOf(options);
    if (!fileSystem.exists(options.path)) {
      return {
        readiness: 'UNINITIALIZED',
        epochFingerprint: null,
        clockHighWaterMs: null,
        effectiveNowMs: null,
        detail: 'authorization state is not initialized',
      };
    }
    const observedNow = nowMs ?? (() => {
      try {
        return (options.clock ?? (() => Date.now()))();
      } catch {
        return Number.NaN;
      }
    })();
    if (!validNow(observedNow)) return invalidStatus('the wall clock is invalid');

    const document = stateDocumentFromFile(options);
    const high = document.clock_high_water_ms;
    const fingerprint = stateFingerprint(document.authorization_epoch);
    if (observedNow < high - CLOCK_ROLLBACK_TOLERANCE_MS) {
      return {
        readiness: 'CLOCK_ROLLBACK',
        epochFingerprint: fingerprint,
        clockHighWaterMs: high,
        effectiveNowMs: high,
        detail: 'wall clock is behind the persisted authorization high-water ceiling',
      };
    }
    return {
      readiness: 'READY',
      epochFingerprint: fingerprint,
      clockHighWaterMs: high,
      effectiveNowMs: Math.max(observedNow, high),
      detail: 'authorization state is valid; epoch and clock are prerequisites only',
    };
  } catch (cause) {
    return invalidStatus(cause instanceof Error ? cause.message : 'authorization state could not be read');
  }
}

function ensureProtectedParent(options: AuthorizationStateOptions): void {
  const parent = dirname(options.path);
  assertPathIsSafe(parent, 'directory', platformOf(options));
  const report = options.security.verify(parent, 'directory');
  if (!report.secure) {
    throw new SecurityError(
      'The authorization state directory is not protected by the required owner-only policy.',
      'Repair the AOM state-root protection and retry. No state was changed.',
    );
  }
}

function writeFully(
  fileSystem: AuthorizationStateFileSystem,
  descriptor: number,
  data: Buffer,
): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = fileSystem.write(descriptor, data, offset, data.byteLength - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new SecurityError(
        'The authorization state temporary file could not be written in full.',
        'The previous state was preserved where possible; retry after checking the local filesystem.',
      );
    }
    offset += written;
  }
}

function closeQuietly(fileSystem: AuthorizationStateFileSystem, descriptor: number): void {
  try {
    fileSystem.close(descriptor);
  } catch {
    /* The original failure is more useful than a close failure. */
  }
}

function removeQuietly(fileSystem: AuthorizationStateFileSystem, path: string): void {
  try {
    fileSystem.unlink(path);
  } catch {
    /* A leftover temp is never used as the target. */
  }
}

function syncContainingDirectory(
  options: AuthorizationStateOptions,
  fileSystem: AuthorizationStateFileSystem,
): void {
  if (platformOf(options) === 'win32') return;
  const parent = dirname(options.path);
  let descriptor: number | undefined;
  try {
    descriptor = fileSystem.open(parent, 'r');
    fileSystem.fsync(descriptor);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
      throw new SecurityError(
        'The authorization state directory could not be durably synchronized.',
        'The state replacement may have completed; inspect status before retrying. No unsafe fallback was used.',
      );
    }
  } finally {
    if (descriptor !== undefined) closeQuietly(fileSystem, descriptor);
  }
}

/** Persists a valid state document using the repository's atomic file pattern. */
export function writeAuthorizationState(
  options: AuthorizationStateWriteOptions,
  document: AuthorizationStateDocument,
): void {
  const fileSystem = fileSystemOf(options);
  let temporary: string | undefined;
  let descriptor: number | undefined;
  let committed = false;
  try {
    ensureProtectedParent(options);
    if (!options.replace && fileSystem.exists(options.path)) {
      throw new SecurityError(
        'The authorization state file already exists; initialization refused to overwrite it.',
        'Use the explicit rotate operation when a new epoch is intended. No state was changed.',
      );
    }

    const serialized = Buffer.from(serializeAuthorizationState(document), 'utf8');
    if (serialized.byteLength > AUTHORIZATION_STATE_MAX_BYTES) {
      throw new SecurityError('The authorization state document exceeds its size bound.', 'No state was changed.');
    }

    temporary = options.path + '.tmp-' + randomUUID();
    descriptor = fileSystem.open(temporary, 'wx', 0o600);
    writeFully(fileSystem, descriptor, serialized);
    fileSystem.fsync(descriptor);
    closeQuietly(fileSystem, descriptor);
    descriptor = undefined;

    options.security.harden(temporary, 'file');
    assertPathIsSafe(temporary, 'file', platformOf(options), { requireSingleLink: true });
    const temporarySecurity = options.security.verify(temporary, 'file');
    if (!temporarySecurity.secure) {
      throw new SecurityError(
        'The authorization state temporary file could not be protected.',
        'The previous state was preserved; resolve local file protection and retry.',
      );
    }

    // A second check closes the supported administrator race. The ownership
    // exclusion held by init/rotate prevents another supported writer.
    if (!options.replace && fileSystem.exists(options.path)) {
      throw new SecurityError(
        'The authorization state file appeared during initialization; overwrite refused.',
        'Retry after resolving the competing local operation. No state was intentionally overwritten.',
      );
    }
    const parsedTemporary = parseAuthorizationState(JSON.parse(fileSystem.read(temporary)) as unknown);
    if (serializeAuthorizationState(parsedTemporary) !== serialized.toString('utf8')) {
      throw new SecurityError('The authorization state serialization is not canonical.', 'No state was changed.');
    }

    fileSystem.rename(temporary, options.path);
    committed = true;
    // Re-apply the existing protection policy to the final name as well as
    // the temporary file. This is a no-op for an already-correct policy and
    // keeps the post-rename verification meaningful on every platform.
    options.security.harden(options.path, 'file');
    syncContainingDirectory(options, fileSystem);

    // Validate the final path after replacement, including its protection.
    stateDocumentFromFile(options);
  } catch (cause) {
    if (descriptor !== undefined) closeQuietly(fileSystem, descriptor);
    if (temporary !== undefined) removeQuietly(fileSystem, temporary);
    if (committed) {
      throw new AuthorizationStatePersistenceError(
        'post-commit',
        'Authorization state replacement may have committed; the new state may already be effective.',
        'Do not blindly retry. Inspect authority-state status before another mutation.',
      );
    }
    if (cause instanceof AuthorizationStatePersistenceError) throw cause;
    if (cause instanceof SecurityError) {
      throw new AuthorizationStatePersistenceError('pre-commit', cause.message, cause.remedy);
    }
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new AuthorizationStatePersistenceError(
        'pre-commit',
        'The authorization state temporary path already exists; initialization refused.',
        'Retry the local operation. No state was intentionally overwritten.',
      );
    }
    if (code === 'EPERM' || code === 'EACCES') {
      throw new AuthorizationStatePersistenceError(
        'pre-commit',
        'The authorization state replacement was refused by the filesystem.',
        'The previous state was preserved where possible. Do not unlink it before retrying.',
      );
    }
    throw new AuthorizationStatePersistenceError(
      'pre-commit',
      'The authorization state could not be persisted safely.',
      'Inspect the state path and retry. No unsafe copy or unlink fallback was used.',
    );
  }
}

export class AuthorizationStateManager {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: AuthorizationStateOptions) {}

  public inspect(nowMs?: number): AuthorizationStateStatus {
    return inspectAuthorizationState(this.options, nowMs);
  }

  /**
   * Advances the persisted ceiling before a future authority-sensitive
   * operation. The queue is deliberately healed after failure so one disk
   * error cannot poison later independent updates.
   */
  public persistHighWaterBeforeAuthorityWork(
    nowMs?: number,
  ): Promise<AuthorizationStateStatus> {
    const observedNow = nowMs ?? (() => {
      try {
        return (this.options.clock ?? (() => Date.now()))();
      } catch {
        return Number.NaN;
      }
    })();
    const operation = this.writeQueue.then(() => {
      const current = this.inspect(observedNow);
      if (current.readiness !== 'READY' || current.clockHighWaterMs === null) return current;
      if (observedNow <= current.clockHighWaterMs) return current;

      const document = stateDocumentFromFile(this.options);
      writeAuthorizationState(
        { ...this.options, replace: true },
        {
          version: AUTHORIZATION_STATE_VERSION,
          authorization_epoch: document.authorization_epoch,
          clock_high_water_ms: observedNow,
        },
      );
      return this.inspect(observedNow);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

/** Exposes the strict file read only for local command implementation/tests. */
export function readAuthorizationStateDocument(options: AuthorizationStateOptions): AuthorizationStateDocument {
  return stateDocumentFromFile(options);
}

export function authorizationStateFingerprint(epoch: string): string {
  if (!EPOCH_PATTERN.test(epoch)) throw new SecurityError('Cannot fingerprint a malformed authorization epoch.');
  return stateFingerprint(epoch);
}
