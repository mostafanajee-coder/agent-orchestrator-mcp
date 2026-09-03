import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import {
  discoverMigrations,
  readMigrationLedger,
  runMigrations,
} from '../../src/store/migrations.js';
import { verifyDatabaseIntegrity } from '../../src/store/integrity.js';

let directories: string[];
let databases: Database.Database[];

function openDatabase(prefix = 'aom-phase10b2-'): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const database = new Database(join(directory, 'orchestrator.db'));
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  database.pragma('recursive_triggers = ON');
  databases.push(database);
  return database;
}

function applyMigrationsThrough(database: Database.Database, version: number): void {
  for (const migration of discoverMigrations().filter((entry) => entry.version <= version)) {
    database.exec(migration.sql);
    database.prepare(
      'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
    ).run(migration.version, '2026-09-03T00:00:00Z');
  }
}

function schemaObjects(database: Database.Database): readonly Record<string, unknown>[] {
  return database.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all() as Record<string, unknown>[];
}

function dataSnapshot(database: Database.Database): Record<string, readonly Record<string, unknown>[]> {
  const tables = [
    'actors',
    'actor_tokens',
    'jobs',
    'worker_runs',
    'evidence',
    'artifacts',
    'decisions',
    'idempotency',
    'audit_log',
  ] as const;
  return Object.fromEntries(tables.map((table) => [
    table,
    database.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all() as Record<string, unknown>[],
  ]));
}

function insertRepresentativeV7Data(database: Database.Database): void {
  database.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('codex', 'principal', 'Codex', '["job:decide"]', 0, '2026-09-03T00:00:00Z');
  database.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('system', 'system', 'System', '[]', 0, '2026-09-03T00:00:00Z');
  database.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('token-fixture', 'codex', 'a'.repeat(64), 'fixture', 0, null, null, '2026-09-03T00:00:00Z');
  database.prepare(
    'INSERT INTO jobs(job_id, workspace, title, spec_json, state, state_reason, authoritative_status, deciding_decision_id, owner_actor_id, cycle, max_cycles, version, deadline_at, stale_after_s, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'job-fixture',
    'C:\\AgentProjects\\fixture',
    'Phase 10B.2 fixture',
    '{}',
    'CREATED',
    null,
    null,
    null,
    'codex',
    0,
    10,
    1,
    null,
    60,
    '2026-09-03T00:00:00Z',
    '2026-09-03T00:00:00Z',
  );
}

beforeEach(() => {
  directories = [];
  databases = [];
});

afterEach(() => {
  for (const database of databases) {
    if (database.open) database.close();
  }
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe('Phase 10B.2 schema foundation', () => {
  it('produces equivalent canonical schemas from fresh and v7-upgraded databases', () => {
    const fresh = openDatabase('aom-phase10b2-fresh-');
    const migrated = openDatabase('aom-phase10b2-migrated-');

    runMigrations(fresh, { fresh: true });
    applyMigrationsThrough(migrated, 7);
    expect(verifyDatabaseIntegrity(migrated).schemaVersion).toBe(7);
    insertRepresentativeV7Data(migrated);
    const beforeData = dataSnapshot(migrated);

    const result = runMigrations(migrated, { fresh: false });
    expect(result).toEqual({
      appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8],
      migrated: true,
    });
    expect(verifyDatabaseIntegrity(fresh)).toMatchObject({
      schemaVersion: 8,
      tableCount: 14,
      appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    expect(verifyDatabaseIntegrity(migrated)).toMatchObject({
      schemaVersion: 8,
      tableCount: 14,
      appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    expect(schemaObjects(migrated)).toEqual(schemaObjects(fresh));
    expect(dataSnapshot(migrated)).toEqual(beforeData);
    expect(migrated.pragma('quick_check', { simple: true })).toBe('ok');
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
    expect(migrated.prepare('SELECT count(*) AS count FROM integrations').get()).toEqual({ count: 0 });
    expect(migrated.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'delegations'",
    ).get()).toBeUndefined();
  });

  it('keeps the v8 table inert and preserves bootstrap authority semantics', () => {
    const database = openDatabase();
    runMigrations(database, { fresh: true });

    expect(database.prepare('SELECT count(*) AS count FROM integrations').get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'delegations'",
    ).get()).toBeUndefined();

    const result = bootstrapProduction(database, new AuditWriter(database), () => Date.parse('2026-09-03T00:00:00Z'));
    expect(result.bootstrapped).toBe(true);
    expect(result.initialToken).toEqual(expect.any(String));
    expect(database.prepare('SELECT actor_id, role FROM actors ORDER BY actor_id').all()).toEqual([
      { actor_id: 'codex', role: 'principal' },
      { actor_id: 'system', role: 'system' },
    ]);
    expect(database.prepare('SELECT count(*) AS count FROM integrations').get()).toEqual({ count: 0 });
  });

  it('enforces generation, identity, timestamp, boolean, duplicate, and no-replace invariants', () => {
    const database = openDatabase();
    runMigrations(database, { fresh: true });
    const insert = database.prepare(
      'INSERT INTO integrations(integration_id, generation, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('integration-fixture', 0, 0, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z');
    expect(database.prepare('SELECT generation, enabled FROM integrations WHERE integration_id = ?').get('integration-fixture')).toEqual({
      generation: 0,
      enabled: 0,
    });

    expect(() => insert.run('negative-generation', -1, 0, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z')).toThrow();
    expect(() => insert.run('invalid-enabled', 0, 2, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z')).toThrow();
    expect(() => insert.run('', 0, 0, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z')).toThrow();
    expect(() => insert.run('invalid-created', 0, 0, '', '2026-09-03T00:00:00Z')).toThrow();
    expect(() => insert.run('invalid-updated', 0, 0, '2026-09-03T00:00:00Z', '')).toThrow();
    expect(() => insert.run('integration-fixture', 0, 0, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z')).toThrow();
    expect(() => database.prepare(
      'INSERT OR REPLACE INTO integrations(integration_id, generation, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('integration-fixture', 9, 1, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z')).toThrow('cannot be replaced');

    database.prepare('UPDATE integrations SET generation = ? WHERE integration_id = ?').run(1, 'integration-fixture');
    expect(database.prepare('SELECT generation FROM integrations WHERE integration_id = ?').get('integration-fixture')).toEqual({ generation: 1 });
    expect(() => database.prepare('UPDATE integrations SET generation = ? WHERE integration_id = ?').run(0, 'integration-fixture')).toThrow('generation cannot decrease');
    database.prepare('UPDATE integrations SET enabled = ?, updated_at = ? WHERE integration_id = ?').run(1, '2026-09-03T00:00:01Z', 'integration-fixture');
    expect(() => database.prepare('UPDATE integrations SET integration_id = ? WHERE integration_id = ?').run('changed', 'integration-fixture')).toThrow('identity and creation time are immutable');
    expect(() => database.prepare('UPDATE integrations SET created_at = ? WHERE integration_id = ?').run('2026-09-03T00:00:02Z', 'integration-fixture')).toThrow('identity and creation time are immutable');
  });

  it('persists integrations across reopen and rejects future or noncanonical schema states', () => {
    const database = openDatabase('aom-phase10b2-reopen-');
    const path = database.name;
    runMigrations(database, { fresh: true });
    database.prepare(
      'INSERT INTO integrations(integration_id, generation, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('persistent-fixture', 0, 0, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z');
    database.close();
    const reopened = new Database(path);
    reopened.pragma('journal_mode = WAL');
    reopened.pragma('foreign_keys = ON');
    reopened.pragma('busy_timeout = 5000');
    reopened.pragma('synchronous = NORMAL');
    reopened.pragma('recursive_triggers = ON');
    databases.push(reopened);
    expect(reopened.prepare('SELECT integration_id FROM integrations').get()).toEqual({ integration_id: 'persistent-fixture' });

    reopened.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(9, '2026-09-03T00:00:00Z');
    expect(() => runMigrations(reopened, { fresh: false })).toThrow('unknown or future version');
    reopened.prepare('DELETE FROM schema_migrations WHERE version = 9').run();
    reopened.exec('DROP TRIGGER trg_integrations_generation_monotonic');
    expect(() => verifyDatabaseIntegrity(reopened)).toThrow('trigger set');
  });

  it('rolls back a failed v8 migration without creating the table or ledger row', () => {
    const database = openDatabase('aom-phase10b2-rollback-');
    const migrations = discoverMigrations().map((migration) => migration.version === 8
      ? { ...migration, sql: 'THIS IS NOT VALID SQL;' }
      : migration);
    expect(() => runMigrations(database, { fresh: true, migrations })).toThrow(/near|syntax/i);
    expect(readMigrationLedger(database).versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'integrations'",
    ).get()).toBeUndefined();
    expect(verifyDatabaseIntegrity(database).schemaVersion).toBe(7);
  });
});
