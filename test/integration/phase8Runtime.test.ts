import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { hashAccessToken, type VerifiedActorAuthInfo } from '../../src/mcp/auth.js';
import { dispatchQa, type Phase6RunOptions } from '../../src/domain/runs.js';
import { recoverOrphanedRuns } from '../../src/domain/recovery.js';
import { ProcessRuntime } from '../../src/workers/processRuntime.js';
import { closeStoreFixture, createStoreFixture, seedJob, type StoreFixture } from '../store/testHelpers.js';

let fixture: StoreFixture;
let audit: AuditWriter;
let principal: VerifiedActorAuthInfo;
let options: Phase6RunOptions;
let runtime: ProcessRuntime;

function registry(): Phase6RunOptions['registry'] {
  return {
    version: 1,
    workers: [{
      worker_id: 'process-worker',
      actor_id: 'worker',
      enabled: true,
      adapter: 'process',
      delivery: 'pipe',
      executable: process.execPath,
      argv_template: ['-e', "process.stdin.resume(); setInterval(() => {}, 1000);"],
      cwd_policy: 'job_workspace',
      environment_allowlist: [],
      default_timeout_ms: 300_000,
      hard_timeout_ms: 900_000,
      max_output_bytes: 4 * 1024 * 1024,
      max_messages: 256,
    }],
  };
}

beforeEach(() => {
  fixture = createStoreFixture();
  audit = new AuditWriter(fixture.db);
  bootstrapProduction(fixture.db, audit);
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('worker', 'worker', 'Process Worker', '["work:report"]', 0, '2026-09-01T00:00:00Z');
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('worker-token', 'worker', hashAccessToken('worker-secret'), 'worker', 0, null, null, '2026-09-01T00:00:00Z');
  seedJob(fixture.db, 'job-shutdown', 'IN_PROGRESS');
  fixture.db.prepare('UPDATE jobs SET workspace = ? WHERE job_id = ?').run(fixture.workspace, 'job-shutdown');
  principal = {
    clientId: 'codex',
    scopes: ['mcp'],
    tokenId: 'codex-token',
    sessionLabel: 'codex-session',
    expiresAt: Number.MAX_SAFE_INTEGER,
    actorId: 'codex',
    role: 'principal',
    capabilities: ['job:decide', 'job:read', 'qa:request'],
  };
  options = {
    registry: registry(),
    leaseKey: Buffer.alloc(32, 15),
    clock: () => Date.parse('2026-09-01T00:00:00Z'),
  };
});

afterEach(() => {
  runtime?.close();
  closeStoreFixture(fixture);
});

describe('Phase 8 process shutdown', () => {
  it('reconciles interrupted owned work as ORPHANED rather than authoritative cancellation', async () => {
    const dispatched = dispatchQa(fixture.db, audit, principal, {
      job_id: 'job-shutdown',
      cycle: 0,
      expected_version: 1,
      requests: [{ worker_id: 'process-worker', task: 'hold' }],
    }, 'shutdown-dispatch', options);
    runtime = new ProcessRuntime({ db: fixture.db, audit, ...options });
    runtime.startRuns(dispatched.runtimeLeases);

    for (let attempt = 0; attempt < 120 && runtime.activeRunIds().length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    expect(runtime.activeRunIds()).toEqual([dispatched.runtimeLeases[0]!.run_id]);

    runtime.close();
    expect(await runtime.waitForIdle(5_000)).toBe(true);
    const recovered = recoverOrphanedRuns(fixture.db, audit, {
      clock: () => Date.parse('2026-09-01T00:00:05Z'),
      reason: 'shutdown_interruption',
    });
    expect(recovered.reconciledRunIds).toEqual([dispatched.runtimeLeases[0]!.run_id]);
    expect(fixture.db.prepare('SELECT status FROM worker_runs WHERE run_id = ?').get(dispatched.runtimeLeases[0]!.run_id)).toEqual({
      status: 'ORPHANED',
    });
    expect(fixture.db.prepare('SELECT state, authoritative_status FROM jobs WHERE job_id = ?').get('job-shutdown')).toEqual({
      state: 'STALLED',
      authoritative_status: null,
    });
    expect(fixture.db.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'run.cancelled'").get()).toEqual({ count: 0 });
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
  });
});
