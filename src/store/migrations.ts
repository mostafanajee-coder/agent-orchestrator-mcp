import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SecurityError } from '../errors.js';
import {
  withImmediateTransaction,
  type SqliteDatabase,
} from './db.js';

export const KNOWN_MIGRATION_VERSIONS = [1, 2, 3] as const;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
}

export interface MigrationLedger {
  readonly exists: boolean;
  readonly versions: readonly number[];
}

export interface MigrationRunOptions {
  readonly fresh: boolean;
  readonly directory?: string;
  readonly migrations?: readonly Migration[];
}

export interface MigrationRunResult {
  readonly appliedVersions: readonly number[];
  readonly migrated: boolean;
}

interface TableInfoRow {
  readonly name: string;
}

interface LedgerRow {
  readonly version: unknown;
  readonly applied_at: unknown;
}

const MIGRATION_FILE = /^(\d+)_([A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;

function defaultMigrationDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'migrations');
}

function fail(message: string, remedy = 'Restore the approved migration set and retry.'): never {
  throw new SecurityError(message, remedy);
}

function parseVersion(fileName: string): number {
  const match = MIGRATION_FILE.exec(fileName);
  if (match === null) {
    fail('Migration filename is not a numbered SQL migration: ' + fileName + '.');
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    fail('Migration filename has an invalid numeric version: ' + fileName + '.');
  }
  return version;
}

export function discoverMigrations(directory = defaultMigrationDirectory()): Migration[] {
  if (!existsSync(directory)) {
    fail('Migration directory is missing: ' + directory + '.');
  }

  const migrations: Migration[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.sql')) continue;
    const version = parseVersion(entry.name);
    migrations.push({
      version,
      name: entry.name.slice(entry.name.indexOf('_') + 1, -4),
      fileName: entry.name,
      sql: readFileSync(join(directory, entry.name), 'utf8'),
    });
  }

  migrations.sort((left, right) => left.version - right.version);
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      fail('Duplicate migration version ' + String(migration.version) + ' was discovered.');
    }
    seen.add(migration.version);
  }
  return migrations;
}

function validateMigrationSet(migrations: readonly Migration[]): void {
  const versions = migrations.map((migration) => migration.version);
  if (
    versions.length !== KNOWN_MIGRATION_VERSIONS.length ||
    versions.some((version, index) => version !== KNOWN_MIGRATION_VERSIONS[index])
  ) {
    fail(
      'The binary migration set is not exactly the approved known set [1,2,3].',
      'Remove unknown, missing, or future migration files before serving.',
    );
  }
  if (migrations.some((migration) => /^\s*(BEGIN(?:\s+(?:IMMEDIATE|EXCLUSIVE|DEFERRED))?|COMMIT|ROLLBACK)\s*;/im.test(migration.sql))) {
    fail(
      'Migration SQL must not own BEGIN, COMMIT, or ROLLBACK; the runner owns the transaction.',
      'Remove transaction-control statements from the migration file.',
    );
  }
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ?',
  ).get('table', name) as { readonly present?: number } | undefined;
  return row?.present === 1;
}

function readMigrationLedgerInternal(db: SqliteDatabase): MigrationLedger {
  if (!tableExists(db, 'schema_migrations')) {
    return { exists: false, versions: [] };
  }

  const tableInfo = db.prepare("PRAGMA table_info('schema_migrations')").all() as TableInfoRow[];
  const names = tableInfo.map((row) => row.name).sort();
  if (names.join(',') !== 'applied_at,version') {
    fail('The schema_migrations ledger has a malformed column set.');
  }

  const rows = db.prepare(
    'SELECT version, applied_at FROM schema_migrations ORDER BY version',
  ).all() as LedgerRow[];
  const versions: number[] = [];
  for (const row of rows) {
    if (
      typeof row.version !== 'number' ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      typeof row.applied_at !== 'string' ||
      row.applied_at.trim() === ''
    ) {
      fail('The schema_migrations ledger contains a malformed row.');
    }
    versions.push(row.version);
  }
  return { exists: true, versions };
}

export function readMigrationLedger(db: SqliteDatabase): MigrationLedger {
  return readMigrationLedgerInternal(db);
}

export function validateAppliedPrefix(
  ledger: MigrationLedger,
  fresh: boolean,
  known: readonly number[] = KNOWN_MIGRATION_VERSIONS,
): void {
  if (!ledger.exists) {
    if (fresh && ledger.versions.length === 0) return;
    fail(
      'An existing database is missing schema_migrations and is not treated as a fresh AOM database.',
      'If this is a known failed fresh-init artifact, remove that exact partial database and rerun init; otherwise restore through the approved recovery process.',
    );
  }

  const seen = new Set<number>();
  for (const version of ledger.versions) {
    if (seen.has(version)) {
      fail('The schema_migrations ledger contains a duplicate version.');
    }
    seen.add(version);
  }

  if (ledger.versions.length === 0) {
    if (fresh) return;
    fail(
      'An existing database has an empty schema_migrations ledger.',
      'Only the explicit fresh-init path may start from an empty ledger.',
    );
  }

  if (ledger.versions.length > known.length) {
    fail('The schema_migrations ledger contains an unknown or future version.');
  }

  if (ledger.versions.some((version) => !known.includes(version))) {
    fail('The schema_migrations ledger contains an unknown or future version.');
  }

  for (let index = 0; index < ledger.versions.length; index += 1) {
    if (ledger.versions[index] !== known[index]) {
      fail(
        'The schema_migrations ledger is not an exact contiguous prefix of the known migration set.',
        'Restore or migrate from an approved contiguous schema state.',
      );
    }
  }
}

function assertExactRows(
  db: SqliteDatabase,
  table: string,
  sql: string,
  expected: readonly string[],
): void {
  const rows = db.prepare(sql).all().map((row) => JSON.stringify(row));
  const wanted = [...expected].sort();
  rows.sort();
  if (rows.length !== wanted.length || rows.some((row, index) => row !== wanted[index])) {
    fail('Migration 002 did not produce the exact approved ' + table + ' seed set.');
  }
}

function verifyMigrationTwoInsideTransaction(db: SqliteDatabase): void {
  assertExactRows(
    db,
    'decision_grants',
    'SELECT decision, authoritative_status FROM decision_grants',
    [
      JSON.stringify({ decision: 'APPROVE', authoritative_status: 'APPROVED' }),
      JSON.stringify({ decision: 'CANCEL', authoritative_status: 'JOB_CANCELLED' }),
      JSON.stringify({ decision: 'COMPLETE', authoritative_status: 'JOB_COMPLETED' }),
      JSON.stringify({ decision: 'DELIVER', authoritative_status: 'READY_FOR_DELIVERY' }),
      JSON.stringify({ decision: 'REJECT', authoritative_status: 'REJECTED' }),
    ],
  );
  assertExactRows(
    db,
    'authoritative_statuses',
    'SELECT authoritative_status, rank, terminal FROM authoritative_statuses',
    [
      JSON.stringify({ authoritative_status: 'APPROVED', rank: 10, terminal: 0 }),
      JSON.stringify({ authoritative_status: 'READY_FOR_DELIVERY', rank: 20, terminal: 0 }),
      JSON.stringify({ authoritative_status: 'JOB_COMPLETED', rank: 30, terminal: 1 }),
      JSON.stringify({ authoritative_status: 'REJECTED', rank: 90, terminal: 1 }),
      JSON.stringify({ authoritative_status: 'JOB_CANCELLED', rank: 91, terminal: 1 }),
    ],
  );

  const triggerNames = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
  ).all().map((row) => (row as { readonly name: string }).name).sort();
  const expectedTriggers = [
    'trg_audit_no_delete',
    'trg_audit_no_update',
    'trg_auth_status_monotonic',
    'trg_auth_status_requires_granting_decision',
    'trg_auth_statuses_frozen_d',
    'trg_auth_statuses_frozen_i',
    'trg_auth_statuses_frozen_u',
    'trg_decisions_no_delete',
    'trg_decisions_no_update',
    'trg_decisions_principal_only',
    'trg_grants_frozen_d',
    'trg_grants_frozen_i',
    'trg_grants_frozen_u',
    'trg_state_matches_auth_status',
  ].sort();
  if (
    triggerNames.length !== expectedTriggers.length ||
    triggerNames.some((name, index) => name !== expectedTriggers[index])
  ) {
    fail('Migration 002 did not install the exact T1–T6 trigger set.');
  }
}

function verifyMigrationThreeInsideTransaction(db: SqliteDatabase): void {
  const triggerNames = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
  ).all().map((row) => (row as { readonly name: string }).name);
  const expected = [
    'trg_jobs_no_delete',
    'trg_jobs_unstamped_on_insert',
  ];
  if (
    triggerNames.length !== expected.length + 14 ||
    !expected.every((name) => triggerNames.includes(name))
  ) {
    fail('Migration 003 did not install the exact T7 job lifecycle trigger set.');
  }
}

export function runMigrations(
  db: SqliteDatabase,
  options: MigrationRunOptions,
): MigrationRunResult {
  const migrations = options.migrations ?? discoverMigrations(options.directory);
  validateMigrationSet(migrations);

  let migrated = false;
  for (;;) {
    const appliedOne = withImmediateTransaction(db, () => {
      const ledger = readMigrationLedgerInternal(db);
      validateAppliedPrefix(ledger, options.fresh);
      const next = migrations.find((migration) => !ledger.versions.includes(migration.version));
      if (next === undefined) return false;

      const expectedNext = ledger.versions.length + 1;
      if (next.version !== expectedNext) {
        fail('The next migration is not the next contiguous version.');
      }

      db.exec(next.sql);
      if (!tableExists(db, 'schema_migrations')) {
        fail('Migration 001 did not create schema_migrations.');
      }
      if (next.version === 2) verifyMigrationTwoInsideTransaction(db);
      if (next.version === 3) verifyMigrationThreeInsideTransaction(db);

      db.prepare(
        'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
      ).run(next.version, new Date().toISOString());
      migrated = true;
      return true;
    });
    if (!appliedOne) break;
  }

  const finalLedger = readMigrationLedgerInternal(db);
  validateAppliedPrefix(finalLedger, false);
  return { appliedVersions: finalLedger.versions, migrated };
}
