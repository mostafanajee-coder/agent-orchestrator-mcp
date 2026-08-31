import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultPhase6WorkerRegistry,
  loadPhase6WorkerRegistry,
  parsePhase6WorkerRegistry,
  validatePhase6WorkerActors,
} from '../../src/config/phase6.js';
import { AuditWriter } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { hashAccessToken } from '../../src/mcp/auth.js';
import {
  closeStoreFixture,
  createStoreFixture,
  type StoreFixture,
} from '../store/testHelpers.js';

let fixture: StoreFixture;

function worker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worker_id: 'fixture-worker',
    actor_id: 'worker',
    enabled: false,
    adapter: 'process',
    delivery: 'pipe',
    executable: process.execPath,
    argv_template: [],
    cwd_policy: 'job_workspace',
    environment_allowlist: [],
    default_timeout_ms: 300_000,
    hard_timeout_ms: 900_000,
    max_output_bytes: 4 * 1024 * 1024,
    max_messages: 256,
    ...overrides,
  };
}

function registry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, workers: [worker(overrides)] };
}

function writeRegistry(value: unknown): void {
  mkdirSync(fixture.layout.root, { recursive: true });
  writeFileSync(fixture.layout.workersFile, JSON.stringify(value), 'utf8');
  fixture.security.harden(fixture.layout.workersFile, 'file');
}

beforeEach(() => {
  fixture = createStoreFixture();
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('Phase 6 worker registry', () => {
  it('creates a disabled starter registry during init', () => {
    const onDisk = JSON.parse(readFileSync(fixture.layout.workersFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual(defaultPhase6WorkerRegistry(process.platform));
    expect((onDisk.workers as Array<Record<string, unknown>>)[0]?.enabled).toBe(false);
  });

  it('parses the strict registry shape and loads the protected file', () => {
    writeRegistry(registry({ enabled: false }));
    expect(loadPhase6WorkerRegistry(fixture.context)).toEqual(registry({ enabled: false }));
    expect(parsePhase6WorkerRegistry(JSON.stringify(registry()), process.platform).workers).toHaveLength(1);
  });

  it('rejects unknown fields, invalid bounds, and duplicate IDs', () => {
    const invalids: readonly unknown[] = [
      { version: 1, extra: true, workers: [worker()] },
      { version: 1, workers: [{ ...worker(), extra: true }] },
      registry({ default_timeout_ms: 900_001 }),
      { version: 1, workers: [worker(), worker()] },
    ];
    for (const invalid of invalids) {
      expect(() => parsePhase6WorkerRegistry(JSON.stringify(invalid), process.platform)).toThrow();
    }
  });

  it('rejects malformed paths and unavailable enabled executables', () => {
    expect(() => parsePhase6WorkerRegistry(JSON.stringify(registry({ executable: 'relative-worker' })), process.platform)).toThrow();
    expect(() => parsePhase6WorkerRegistry(JSON.stringify(registry({ enabled: true, executable: join(fixture.workspace, 'missing-worker') })), process.platform)).toThrow('unavailable');
  });

  it('requires an enabled worker actor in the authority database', () => {
    const audit = new AuditWriter(fixture.db);
    bootstrapProduction(fixture.db, audit);
    const valid = parsePhase6WorkerRegistry(JSON.stringify(registry({ enabled: true })), process.platform);
    expect(() => validatePhase6WorkerActors(fixture.db, valid)).toThrow('enabled worker actor');

    fixture.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('worker', 'worker', 'Worker', '["work:report"]', 0, '2026-08-31T00:00:00Z');
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('worker-token', 'worker', hashAccessToken('worker-secret'), 'worker', 0, null, null, '2026-08-31T00:00:00Z');
    expect(() => validatePhase6WorkerActors(fixture.db, valid)).not.toThrow();
  });
});
