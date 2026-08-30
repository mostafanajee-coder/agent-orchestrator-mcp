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

beforeEach(openTestDatabase);
afterEach(closeTestDatabase);

describe('migration discovery and exact ledger contract', () => {
  it('discovers exactly the numeric Phase 3 set in order', () => {
    expect(approvedMigrations().map((migration) => migration.version)).toEqual([1, 2]);
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
    writeFileSync(join(directory, '003_future.sql'), 'SELECT 1;');
    expect(() => runMigrations(db, { fresh: true, directory })).toThrow('exactly the approved known set');
  });

  it('accepts only an exact contiguous prefix', () => {
    validateAppliedPrefix({ exists: true, versions: [1] }, false);
    validateAppliedPrefix({ exists: true, versions: [1, 2] }, false);
    expect(() => validateAppliedPrefix({ exists: true, versions: [] }, false)).toThrow('empty');
    expect(() => validateAppliedPrefix({ exists: true, versions: [2] }, false)).toThrow('contiguous prefix');
    expect(() => validateAppliedPrefix({ exists: true, versions: [1, 3] }, false)).toThrow('contiguous prefix');
    expect(() => validateAppliedPrefix({ exists: true, versions: [1, 2, 3] }, false)).toThrow('unknown or future');
  });
});

describe('migration runner', () => {
  it('applies a fresh database atomically and verifies the current schema', () => {
    const result = runMigrations(db, { fresh: true });
    expect(result).toEqual({ appliedVersions: [1, 2], migrated: true });
    expect(verifyDatabaseIntegrity(db).appliedVersions).toEqual([1, 2]);
  });

  it('re-runs a current database without applying anything', () => {
    runMigrations(db, { fresh: true });
    const result = runMigrations(db, { fresh: false });
    expect(result).toEqual({ appliedVersions: [1, 2], migrated: false });
  });

  it('upgrades an existing {1} database to {1,2}', () => {
    applyMigrationOne();
    const result = runMigrations(db, { fresh: false });
    expect(result.appliedVersions).toEqual([1, 2]);
    expect(readMigrationLedger(db).versions).toEqual([1, 2]);
  });

  it.each([
    [[], 'empty'],
    [[2], 'contiguous prefix'],
    [[1, 3], 'contiguous prefix'],
    [[1, 2, 3], 'unknown or future'],
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
    const migrations = approvedMigrations();
    const failed = migrations.map((migration) => migration.version === 2
      ? { ...migration, sql: 'THIS IS NOT VALID SQL;' }
      : migration);
    expect(() => runMigrations(db, { fresh: false, migrations: failed })).toThrow();
    expect(readMigrationLedger(db).versions).toEqual([1]);
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
});
