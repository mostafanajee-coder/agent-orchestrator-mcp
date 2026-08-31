import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createInMemoryTokenResolver } from '../../src/mcp/auth.js';
import { startHttpServer } from '../../src/mcp/http.js';
import { startEnvironmentStdioServer } from '../../src/mcp/stdio.js';
import { assertServeReady } from '../../src/commands/startup.js';
import {
  EXPECTED_TRIGGERS,
  verifyDatabaseIntegrity,
} from '../../src/store/integrity.js';
import {
  closeStoreFixture,
  createStoreFixture,
  type StoreFixture,
} from './testHelpers.js';

let fixture: StoreFixture;

function db(): Database.Database {
  return fixture.db;
}

function tamperTrigger(name: string): void {
  db().exec(
    'DROP TRIGGER "' + name + '"; ' +
    'CREATE TRIGGER "' + name + '" BEFORE INSERT ON actors BEGIN SELECT 1; END;',
  );
}

function prepareDoctorForServe(): void {
  for (const path of [fixture.layout.databaseWal, fixture.layout.databaseShm]) {
    if (existsSync(path)) fixture.security.harden(path, 'file');
  }
}

beforeEach(() => {
  fixture = createStoreFixture();
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('canonical trigger definitions', () => {
  it.each(EXPECTED_TRIGGERS)('rejects a weakened same-name trigger: %s', (name) => {
    tamperTrigger(name);
    expect(() => verifyDatabaseIntegrity(db())).toThrow('canonical definition');
  });
});

describe('canonical index and table definitions', () => {
  it('rejects a non-unique same-name principal index and preserves the DB gate', () => {
    db().exec(
      "DROP INDEX ux_actors_single_principal; " +
      "CREATE INDEX ux_actors_single_principal ON actors(role) WHERE role = 'principal';",
    );
    expect(() => verifyDatabaseIntegrity(db())).toThrow('canonical definition');

    db().exec(
      "DROP INDEX ux_actors_single_principal; " +
      "CREATE UNIQUE INDEX ux_actors_single_principal ON actors(role) WHERE role = 'principal';",
    );
    expect(() => verifyDatabaseIntegrity(db())).not.toThrow();
    db().prepare(
      "INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES ('codex', 'principal', 'Codex', '[]', 0, ?)",
    ).run('2026-08-30T00:00:00Z');
    expect(() => db().prepare(
      "INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES ('second', 'principal', 'Second', '[]', 0, ?)",
    ).run('2026-08-30T00:00:00Z')).toThrow();
  });

  it('rejects a same-name actor_tokens table without digest constraints', () => {
    db().pragma('foreign_keys = OFF');
    db().exec(
      'DROP TABLE actor_tokens; ' +
      'CREATE TABLE actor_tokens (' +
      'token_id TEXT, actor_id TEXT, token_sha256 TEXT, label TEXT, ' +
      'disabled INTEGER, expires_at TEXT, last_used_at TEXT, created_at TEXT' +
      '); ' +
      'CREATE INDEX ix_actor_tokens_actor ON actor_tokens(actor_id);',
    );
    db().pragma('foreign_keys = ON');
    expect(() => verifyDatabaseIntegrity(db())).toThrow('canonical definition');
  });

  it('rejects removal of the lease composite relation', () => {
    db().pragma('foreign_keys = OFF');
    db().exec(
      'DROP TABLE leases; ' +
      'CREATE TABLE leases (' +
      'lease_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES worker_runs(run_id), ' +
      'job_id TEXT NOT NULL, cycle INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES actors(actor_id), ' +
      'nonce TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL' +
      '); ' +
      'CREATE UNIQUE INDEX ux_leases_run_id ON leases(run_id);',
    );
    db().pragma('foreign_keys = ON');
    expect(() => verifyDatabaseIntegrity(db())).toThrow('canonical definition');
  });
});

describe('START-06/REG-01 serve tamper gate', () => {
  it('rejects a tampered same-name trigger before HTTP bind', () => {
    tamperTrigger('trg_auth_status_requires_granting_decision');
    prepareDoctorForServe();
    expect(() => startHttpServer({
      resolver: createInMemoryTokenResolver([]),
      version: '0.0.0-test',
      port: 0,
      verifyStartup: () => assertServeReady(fixture.context),
    })).toThrow('canonical version 6');
  });

  it('rejects a tampered same-name T7 trigger before stdio output', () => {
    tamperTrigger('trg_jobs_no_delete');
    prepareDoctorForServe();
    const input = new PassThrough();
    const output = new PassThrough();
    expect(() => startEnvironmentStdioServer({
      version: '0.0.0-test',
      environment: { ORCHESTRATOR_ACTOR_TOKEN: 'phase3-test' },
      transport: new StdioServerTransport(input, output),
      verifyStartup: () => assertServeReady(fixture.context),
    })).toThrow('canonical version 6');
    expect(output.readableLength).toBe(0);
    input.destroy();
    output.destroy();
  });
});
