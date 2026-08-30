import Database from 'better-sqlite3';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  type Stats,
} from 'node:fs';

import type { StateLayout } from '../config/stateRoot.js';
import type { CommandContext } from '../commands/context.js';
import { SecurityError } from '../errors.js';
import { assertPathIsSafe } from '../security/pathSafety.js';
import type { PathKind, SecurityProvider } from '../security/provider.js';

export type SqliteDatabase = Database.Database;

export interface DatabasePaths {
  readonly database: string;
  readonly wal: string;
  readonly shm: string;
}

export interface OpenDatabaseResult {
  readonly db: SqliteDatabase;
  readonly fresh: boolean;
  /** Exact DB/WAL/SHM paths that were absent when this fresh attempt began. */
  readonly freshFiles: readonly string[];
}

export type SqliteDatabaseOpener = (
  filename: string,
  options: Database.Options,
) => SqliteDatabase;

export interface DatabaseOpenDependencies {
  readonly opener?: SqliteDatabaseOpener;
}

export type SynchronousTransactionCallback<T> = () => T & (
  T extends PromiseLike<unknown> ? never : unknown
);

export interface SqlitePragmaPolicy {
  readonly journalMode: 'wal';
  readonly foreignKeys: 1;
  readonly busyTimeout: 5000;
  readonly synchronous: 1;
}

export const SQLITE_PRAGMA_POLICY: SqlitePragmaPolicy = {
  journalMode: 'wal',
  foreignKeys: 1,
  busyTimeout: 5000,
  synchronous: 1,
};

const defaultOpener: SqliteDatabaseOpener = (filename, options) => new Database(filename, options);

export function databasePaths(layout: StateLayout): DatabasePaths {
  return {
    database: layout.database,
    wal: layout.databaseWal,
    shm: layout.databaseShm,
  };
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SecurityError(
      'Could not inspect database path ' + path + '.',
      'Check that the path is reachable and retry. No database mutation was attempted.',
    );
  }
}

function assertSecurePath(
  path: string,
  kind: PathKind,
  security: SecurityProvider,
  platform: NodeJS.Platform,
): void {
  assertPathIsSafe(path, kind, platform);
  let report;
  try {
    report = security.verify(path, kind);
  } catch (cause) {
    throw new SecurityError(
      'Could not verify protection for ' + path + '.',
      cause instanceof Error ? cause.message : 'Resolve the protection problem and retry.',
    );
  }
  if (!report.secure) {
    throw new SecurityError(
      path + ' is not protected: ' + report.problems.join('; ') + '.',
      'Resolve the permission or path-safety problem and retry. No database was opened.',
    );
  }
}

function assertDatabaseParentSecure(
  layout: StateLayout,
  security: SecurityProvider,
  platform: NodeJS.Platform,
): void {
  assertSecurePath(layout.data, 'directory', security, platform);
}

function assertOptionalSidecarSecure(
  path: string,
  security: SecurityProvider,
  platform: NodeJS.Platform,
): void {
  if (lstatIfPresent(path) === undefined) return;
  assertSecurePath(path, 'file', security, platform);
}

/**
 * Checks the authoritative DB and any existing WAL/SHM sidecars without
 * opening SQLite. This is shared by writable init/serve preflight; doctor
 * uses its filesystem-only equivalent in doctorFiles.ts.
 */
export function assertExistingDatabaseFilesSecure(
  layout: StateLayout,
  security: SecurityProvider,
  platform: NodeJS.Platform,
): void {
  assertDatabaseParentSecure(layout, security, platform);
  if (lstatIfPresent(layout.database) === undefined) {
    throw new SecurityError(
      'The authoritative database ' + layout.database + ' is missing.',
      'Run init to create the schema database. Serve never creates it implicitly.',
    );
  }
  assertSecurePath(layout.database, 'file', security, platform);
  assertOptionalSidecarSecure(layout.databaseWal, security, platform);
  assertOptionalSidecarSecure(layout.databaseShm, security, platform);
}

function createSecureDatabaseFile(
  layout: StateLayout,
  security: SecurityProvider,
  platform: NodeJS.Platform,
): void {
  assertDatabaseParentSecure(layout, security, platform);
  if (lstatIfPresent(layout.database) !== undefined) {
    throw new SecurityError(
      'The authoritative database ' + layout.database + ' appeared during secure creation.',
      'Retry init and inspect the database path for concurrent activity.',
    );
  }

  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(layout.database, 'wx', 0o600);
    created = true;
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    assertPathIsSafe(layout.database, 'file', platform);
    security.harden(layout.database, 'file');
    assertSecurePath(layout.database, 'file', security, platform);
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    if (created) removeFreshDatabaseFiles(layout, [layout.database]);
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Could not securely create the authoritative database ' + layout.database + '.',
      cause instanceof Error ? cause.message : 'Check the data directory and retry.',
    );
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SecurityError(
        'Could not remove the temporary database file ' + path + ' after a failed init.',
        'Remove only that exact file after verifying it is the failed init artifact.',
      );
    }
  }
}

/** Removes only the exact DB/WAL/SHM paths recorded for a fresh attempt. */
export function removeFreshDatabaseFiles(
  layout: StateLayout,
  freshFiles: readonly string[],
): void {
  const allowed = new Set(freshFiles);
  for (const path of [layout.databaseShm, layout.databaseWal, layout.database]) {
    if (allowed.has(path)) removeIfPresent(path);
  }
}

function pragmaSimple(db: SqliteDatabase, statement: string): unknown {
  return db.pragma(statement, { simple: true });
}

function normaliseJournalMode(value: unknown): string {
  return String(value).toLowerCase();
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export function verifyPragmaPolicy(db: SqliteDatabase): SqlitePragmaPolicy {
  const policy = {
    journalMode: normaliseJournalMode(pragmaSimple(db, 'journal_mode')),
    foreignKeys: numberValue(pragmaSimple(db, 'foreign_keys')),
    busyTimeout: numberValue(pragmaSimple(db, 'busy_timeout')),
    synchronous: numberValue(pragmaSimple(db, 'synchronous')),
  };
  if (
    policy.journalMode !== SQLITE_PRAGMA_POLICY.journalMode ||
    policy.foreignKeys !== SQLITE_PRAGMA_POLICY.foreignKeys ||
    policy.busyTimeout !== SQLITE_PRAGMA_POLICY.busyTimeout ||
    policy.synchronous !== SQLITE_PRAGMA_POLICY.synchronous
  ) {
    throw new SecurityError(
      'The SQLite PRAGMA policy is not the approved Phase 3 policy.',
      'Inspect the database configuration and retry. No later operation was authorized.',
    );
  }
  return SQLITE_PRAGMA_POLICY;
}

function configurePragmas(db: SqliteDatabase): void {
  pragmaSimple(db, 'journal_mode = WAL');
  pragmaSimple(db, 'foreign_keys = ON');
  pragmaSimple(db, 'busy_timeout = 5000');
  pragmaSimple(db, 'synchronous = NORMAL');
  verifyPragmaPolicy(db);
}

function hardenNewSidecars(
  paths: DatabasePaths,
  before: ReadonlySet<string>,
  security: SecurityProvider,
): void {
  for (const path of [paths.wal, paths.shm]) {
    if (!before.has(path) && lstatIfPresent(path) !== undefined) {
      security.harden(path, 'file');
    }
  }
}

function openWritableDatabase(
  layout: StateLayout,
  security: SecurityProvider,
  platform: NodeJS.Platform,
  dependencies: DatabaseOpenDependencies,
): SqliteDatabase {
  const paths = databasePaths(layout);
  const existingSidecars = new Set(
    [paths.wal, paths.shm].filter((path) => lstatIfPresent(path) !== undefined),
  );
  let db: SqliteDatabase | undefined;
  try {
    db = (dependencies.opener ?? defaultOpener)(paths.database, {
      fileMustExist: true,
      readonly: false,
      timeout: SQLITE_PRAGMA_POLICY.busyTimeout,
    });
    configurePragmas(db);
    hardenNewSidecars(paths, existingSidecars, security);
    assertExistingDatabaseFilesSecure(layout, security, platform);
    return db;
  } catch (cause) {
    if (db?.open) {
      try {
        db.close();
      } catch {
        // Preserve the original opening/configuration failure.
      }
    }
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Could not open the authoritative database ' + paths.database + '.',
      cause instanceof Error ? cause.message : 'Check the database file and retry.',
    );
  }
}

export function openDatabaseForInit(
  context: CommandContext,
  dependencies: DatabaseOpenDependencies = {},
): OpenDatabaseResult {
  const { layout, security, platform } = context;
  const fresh = lstatIfPresent(layout.database) === undefined;
  const freshFiles = fresh
    ? [layout.database, layout.databaseWal, layout.databaseShm]
      .filter((path) => lstatIfPresent(path) === undefined)
    : [];
  if (fresh) createSecureDatabaseFile(layout, security, platform);
  else assertExistingDatabaseFilesSecure(layout, security, platform);

  try {
    return {
      db: openWritableDatabase(layout, security, platform, dependencies),
      fresh,
      freshFiles,
    };
  } catch (cause) {
    if (fresh) {
      try {
        removeFreshDatabaseFiles(layout, freshFiles);
      } catch {
        // Preserve the database error; cleanup failure remains visible on disk.
      }
    }
    throw cause;
  }
}

export function openExistingDatabaseForServe(
  context: CommandContext,
  dependencies: DatabaseOpenDependencies = {},
): OpenDatabaseResult {
  const { layout, security, platform } = context;
  assertExistingDatabaseFilesSecure(layout, security, platform);
  return {
    db: openWritableDatabase(layout, security, platform, dependencies),
    fresh: false,
    freshFiles: [],
  };
}

/** Idempotent close helper for every init/serve path. */
export function closeDatabase(db: SqliteDatabase): void {
  if (db.open) db.close();
}

/**
 * Gives one caller explicit ownership of BEGIN IMMEDIATE/COMMIT/ROLLBACK.
 * Nested ownership is refused rather than silently weakening atomicity.
 */
export function withImmediateTransaction<T>(
  db: SqliteDatabase,
  callback: SynchronousTransactionCallback<T>,
): T {
  if (db.inTransaction) {
    throw new SecurityError(
      'Cannot start a nested BEGIN IMMEDIATE transaction.',
      'Pass the existing transaction-bound handle to the operation instead.',
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as { readonly then?: unknown }).then === 'function'
    ) {
      throw new SecurityError(
        'withImmediateTransaction does not support asynchronous callbacks.',
        'Use a synchronous callback so all work completes before COMMIT.',
      );
    }
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original failure is the actionable one.
    }
    throw cause;
  }
}
