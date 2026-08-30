import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStructuralRepositories } from '../../src/store/repositories.js';
import { verifyDatabaseIntegrity } from '../../src/store/integrity.js';
import {
  closeStoreFixture,
  createStoreFixture,
  type StoreFixture,
} from './testHelpers.js';

let fixture: StoreFixture;

beforeEach(() => {
  fixture = createStoreFixture();
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('Phase 3 schema and integrity', () => {
  it('creates exactly 13 approved tables and no production authority rows', () => {
    const tables = fixture.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => (row as { readonly name: string }).name);
    expect(tables).toEqual([
      'actor_tokens',
      'actors',
      'artifacts',
      'audit_log',
      'authoritative_statuses',
      'decision_grants',
      'decisions',
      'evidence',
      'idempotency',
      'jobs',
      'leases',
      'schema_migrations',
      'worker_runs',
    ]);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM actors').get()).toEqual({ count: 0 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM actor_tokens').get()).toEqual({ count: 0 });
  });

  it('reports the current schema and approved PRAGMA policy', () => {
    const report = verifyDatabaseIntegrity(fixture.db);
    expect(report.schemaVersion).toBe(2);
    expect(report.tableCount).toBe(13);
    expect(report.triggerCount).toBe(14);
    expect(report.appliedVersions).toEqual([1, 2]);
    expect(report.pragmaPolicy).toEqual({
      journalMode: 'wal',
      foreignKeys: 1,
      busyTimeout: 5000,
      synchronous: 1,
    });
  });

  it('preserves the exact actor_tokens columns without scopes or session_label', () => {
    const columns = fixture.db.prepare(
      "PRAGMA table_info('actor_tokens')",
    ).all().map((row) => (row as { readonly name: string }).name);
    expect(columns).toEqual([
      'token_id',
      'actor_id',
      'token_sha256',
      'label',
      'disabled',
      'expires_at',
      'last_used_at',
      'created_at',
    ]);
    expect(columns).not.toContain('scopes');
    expect(columns).not.toContain('session_label');
  });

  it('exposes only typed structural repositories and preserves many-to-one tokens', () => {
    const repositories = createStructuralRepositories(fixture.db);
    repositories.actors.insert({
      actorId: 'codex',
      role: 'principal',
      displayName: 'Codex',
      capabilitiesJson: '["job:decide"]',
      disabled: 0,
      createdAt: '2026-08-30T00:00:00Z',
    });
    repositories.actorTokens.insert({
      tokenId: 'token-a',
      actorId: 'codex',
      tokenSha256: 'a'.repeat(64),
      label: 'codex-a',
      disabled: 0,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: '2026-08-30T00:00:00Z',
    });
    repositories.actorTokens.insert({
      tokenId: 'token-b',
      actorId: 'codex',
      tokenSha256: 'b'.repeat(64),
      label: 'codex-b',
      disabled: 0,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: '2026-08-30T00:00:00Z',
    });

    expect(repositories.actorTokens.listForActor('codex')).toHaveLength(2);
    expect(repositories.actors.get('codex')?.actorId).toBe('codex');
  });

  it('rejects an unexpected user table during integrity verification', () => {
    fixture.db.exec('CREATE TABLE unexpected_table (id INTEGER PRIMARY KEY)');
    expect(() => verifyDatabaseIntegrity(fixture.db)).toThrow('exactly the approved 13-table schema');
  });
});
