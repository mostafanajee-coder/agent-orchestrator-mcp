import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverMigrations,
  readMigrationLedger,
  runMigrations,
  validateAppliedPrefix,
} from '../../src/store/migrations.js';
import {
  withImmediateTransaction,
  type SqliteDatabase,
} from '../../src/store/db.js';
import { verifyDatabaseIntegrity } from '../../src/store/integrity.js';

let directory: string;
let db: Database.Database;

function openTestDatabase(): void {
  directory = mkdtempSync(join(tmpdir(), 'aom-phase3-migrations-'));
  db = new Database(join(directory, 'orchestrator.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('recursive_triggers = ON');
}

function closeTestDatabase(): void {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
}

function approvedMigrations(): ReturnType<typeof discoverMigrations> {
  return discoverMigrations();
}

function createLedger(versions: readonly number[]): void {
  db.exec(
    'CREATE TABLE schema_migrations (' +
      'version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL' +
    ')',
  );
  const insert = db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, '2026-08-30T00:00:00Z')",
  );
  for (const version of versions) insert.run(version);
}

function applyMigrationOne(): void {
  const migration = approvedMigrations().find((entry) => entry.version === 1);
  if (migration === undefined) throw new Error('migration 001 missing');
  db.exec(migration.sql);
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-08-30T00:00:00Z')",
  ).run();
}

function applyMigrationTwo(): void {
  const migration = approvedMigrations().find((entry) => entry.version === 2);
  if (migration === undefined) throw new Error('migration 002 missing');
  db.exec(migration.sql);
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (2, '2026-08-30T00:00:00Z')",
  ).run();
}

function applyMigrationThree(): void {
  const migration = approvedMigrations().find((entry) => entry.version === 3);
  if (migration === undefined) throw new Error('migration 003 missing');
  db.exec(migration.sql);
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (3, '2026-08-30T00:00:00Z')",
  ).run();
}

function applyMigrationFour(): void {
  const migration = approvedMigrations().find((entry) => entry.version === 4);
  if (migration === undefined) throw new Error('migration 004 missing');
  db.exec(migration.sql);
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (4, '2026-08-30T00:00:00Z')",
  ).run();
}

beforeEach(openTestDatabase);
afterEach(closeTestDatabase);

describe('migration discovery and exact ledger contract', () => {
  it('REG-01 discovers exactly the numeric Phase 7 set in order', () => {
    expect(approvedMigrations().map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(approvedMigrations().every((migration) => !/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(migration.sql))).toBe(
      true,
    );
  });

  it('rejects an invalid numbered SQL filename', () => {
    const invalid = join(directory, 'future.sql');
    writeFileSync(invalid, 'SELECT 1;');
    expect(() => discoverMigrations(directory)).toThrow('not a numbered SQL migration');
    expect(existsSync(invalid)).toBe(true);
  });

  it('rejects an extra future migration from the binary set', () => {
    writeFileSync(join(directory, '005_future.sql'), 'SELECT 1;');
    expect(() => runMigrations(db, { fresh: true, directory })).toThrow('exactly the approved known set');
  });

  it('accepts only an exact contiguous prefix', () => {
    validateAppliedPrefix({ exists: true, versions: [1] }, false);
    validateAppliedPrefix({ exists: true, versions: [1, 2] }, false);
    validateAppliedPrefix({ exists: true, versions: [1, 2, 3] }, false);
    validateAppliedPrefix({ exists: true, versions: [1, 2, 3, 4] }, false);
    expect(() => validateAppliedPrefix({ exists: true, versions: [] }, false)).toThrow('empty');
    expect(() => validateAppliedPrefix({ exists: true, versions: [2] }, false)).toThrow('contiguous prefix');
    expect(() => validateAppliedPrefix({ exists: true, versions: [1, 3] }, false)).toThrow('contiguous prefix');
    expect(() => validateAppliedPrefix({ exists: true, versions: [1, 2, 3, 5] }, false)).toThrow('contiguous prefix');
  });
});

describe('migration runner', () => {
  it('applies a fresh database atomically and verifies the current schema', () => {
    const result = runMigrations(db, { fresh: true });
    expect(result).toEqual({ appliedVersions: [1, 2, 3, 4, 5, 6, 7], migrated: true });
    expect(verifyDatabaseIntegrity(db).appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('re-runs a current database without applying anything', () => {
    runMigrations(db, { fresh: true });
    const result = runMigrations(db, { fresh: false });
    expect(result).toEqual({ appliedVersions: [1, 2, 3, 4, 5, 6, 7], migrated: false });
  });

  it('upgrades an existing {1} database to {1,2,3,4,5,6,7}', () => {
    applyMigrationOne();
    const result = runMigrations(db, { fresh: false });
    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(readMigrationLedger(db).versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('upgrades an existing {1,2} database to {1,2,3,4,5,6,7}', () => {
    applyMigrationOne();
    applyMigrationTwo();
    const result = runMigrations(db, { fresh: false });
    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(readMigrationLedger(db).versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('upgrades an existing schema-v3 database to schema-v7', () => {
    applyMigrationOne();
    applyMigrationTwo();
    applyMigrationThree();
    const result = runMigrations(db, { fresh: false });
    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(readMigrationLedger(db).versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('O1-01/O1-03 refuses migration 005 when a pre-existing audit sequence is non-positive', () => {
    applyMigrationOne();
    applyMigrationTwo();
    applyMigrationThree();
    applyMigrationFour();
    db.prepare(
      "INSERT INTO audit_log(seq, ts, actor_id, actor_role, request_id, action, result, prev_hash, hash) VALUES (-1, '2026-08-30T00:00:00Z', 'system', 'system', 'negative', 'auth.rejected', 'denied', ?, ?)",
    ).run('0'.repeat(64), '1'.repeat(64));
    expect(() => runMigrations(db, { fresh: false })).toThrow('non-positive existing sequence');
    expect(readMigrationLedger(db).versions).toEqual([1, 2, 3, 4]);
  });

  it.each([
    [[], 'empty'],
    [[2], 'contiguous prefix'],
    [[1, 3], 'contiguous prefix'],
    [[1, 2, 3, 5], 'contiguous prefix'],
  ])('rejects invalid existing ledger %j', (versions, message) => {
    createLedger(versions);
    expect(() => runMigrations(db, { fresh: false })).toThrow(message);
  });

  it('rejects an existing database with no schema_migrations table', () => {
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    expect(() => runMigrations(db, { fresh: false })).toThrow('missing schema_migrations');
  });

  it('does not ledger a failed migration', () => {
    applyMigrationOne();
    applyMigrationTwo();
    applyMigrationThree();
    const migrations = approvedMigrations();
    const failed = migrations.map((migration) => migration.version === 4
      ? { ...migration, sql: 'THIS IS NOT VALID SQL;' }
      : migration);
    expect(() => runMigrations(db, { fresh: false, migrations: failed })).toThrow();
    expect(readMigrationLedger(db).versions).toEqual([1, 2, 3]);
  });

  it('rolls back a failed immediate transaction', () => {
    expect(() => withImmediateTransaction(db, () => {
      db.exec('CREATE TABLE transient_table (id INTEGER PRIMARY KEY)');
      throw new Error('forced migration failure');
    })).toThrow('forced migration failure');
    expect(db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'transient_table'",
    ).get()).toBeUndefined();
  });

  it('reads the ledger only after BEGIN IMMEDIATE is acquired', () => {
    runMigrations(db, { fresh: true });
    const events: string[] = [];
    const wrapped = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'exec') {
          return (sql: string) => {
            if (sql.trim().toUpperCase() === 'BEGIN IMMEDIATE') events.push('BEGIN IMMEDIATE');
            return target.exec(sql);
          };
        }
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('schema_migrations')) events.push('LEDGER_READ');
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as SqliteDatabase;

    runMigrations(wrapped, { fresh: false });
    expect(events.indexOf('BEGIN IMMEDIATE')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('LEDGER_READ')).toBeGreaterThan(events.indexOf('BEGIN IMMEDIATE'));
  });

  it('rejects an asynchronous transaction callback before COMMIT', async () => {
    const callback = (async () => {
      db.exec('CREATE TABLE async_transient (id INTEGER PRIMARY KEY)');
      await Promise.resolve();
    }) as unknown as () => unknown;

    expect(() => withImmediateTransaction(db, callback)).toThrow(
      'does not support asynchronous callbacks',
    );
    await Promise.resolve();
    expect(db.inTransaction).toBe(false);
    expect(db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'async_transient'",
    ).get()).toBeUndefined();
  });
});
