import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { hashAccessToken, type VerifiedActorAuthInfo } from '../../src/mcp/auth.js';
import {
  cancelRunsForJob,
  dispatchQa,
  listRunStatus,
  reportRun,
  startRun,
  type Phase6RunOptions,
} from '../../src/domain/runs.js';
import { seedJob, closeStoreFixture, createStoreFixture, type StoreFixture } from './testHelpers.js';

let fixture: StoreFixture;
let audit: AuditWriter;
let principal: VerifiedActorAuthInfo;
let worker: VerifiedActorAuthInfo;
let options: Phase6RunOptions;

function actor(
  actorId: string,
  role: 'principal' | 'worker',
  capabilities: readonly ('job:create' | 'job:read' | 'job:decide' | 'qa:request' | 'work:report')[],
  tokenId: string,
): VerifiedActorAuthInfo {
  return {
    clientId: actorId,
    scopes: ['mcp'],
    tokenId,
    sessionLabel: actorId + '-session',
    expiresAt: Number.MAX_SAFE_INTEGER,
    actorId,
    role,
    capabilities,
  };
}

function registry(workerId = 'fixture-worker', actorId = 'worker'): Phase6RunOptions['registry'] {
  return {
    version: 1 as const,
    workers: [{
      worker_id: workerId,
      actor_id: actorId,
      enabled: true,
      adapter: 'process' as const,
      delivery: 'pipe' as const,
      executable: process.execPath,
      argv_template: [] as string[],
      cwd_policy: 'job_workspace' as const,
      environment_allowlist: [] as string[],
      default_timeout_ms: 300_000,
      hard_timeout_ms: 900_000,
      max_output_bytes: 4 * 1024 * 1024,
      max_messages: 256,
    }],
  };
}

function dispatchInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: 'job-1',
    cycle: 0,
    expected_version: 1,
    requests: [{ worker_id: 'fixture-worker', task: 'run fixture', params: { mode: 'test' } }],
    ...overrides,
  };
}

beforeEach(() => {
  fixture = createStoreFixture();
  audit = new AuditWriter(fixture.db);
  bootstrapProduction(fixture.db, audit);
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('worker', 'worker', 'Fixture Worker', '["work:report"]', 0, '2026-08-31T00:00:00Z');
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('worker-token', 'worker', hashAccessToken('worker-secret'), 'worker', 0, null, null, '2026-08-31T00:00:00Z');
  seedJob(fixture.db, 'job-1', 'IN_PROGRESS');
  principal = actor('codex', 'principal', ['job:decide', 'job:read', 'qa:request'], 'codex-token');
  worker = actor('worker', 'worker', ['work:report'], 'worker-token');
  options = { registry: registry(), leaseKey: Buffer.alloc(32, 5), clock: () => Date.parse('2026-08-31T00:00:00Z') };
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('Phase 6 run lifecycle domain', () => {
  it('atomically dispatches, starts, reports, settles, and replays a run', () => {
    const dispatched = dispatchQa(fixture.db, audit, principal, dispatchInput(), 'dispatch-1', options);
    expect(dispatched.state).toBe('QA_RUNNING');
    expect(dispatched.version).toBe(2);
    expect(dispatched.runs).toHaveLength(1);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM worker_runs').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM leases').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare('SELECT state, authoritative_status FROM jobs WHERE job_id = ?').get('job-1')).toEqual({
      state: 'QA_RUNNING',
      authoritative_status: null,
    });

    startRun(fixture.db, audit, dispatched.runs[0]!.run_id, 'run-start-1', options);
    const reported = reportRun(fixture.db, audit, worker, {
      lease: dispatched.runtimeLeases[0]!.lease,
      verdict: 'PASS',
      summary: 'completed',
    }, 'report-1', options);
    expect(reported).toMatchObject({ status: 'SUCCEEDED', accepted: true, duplicate: false, job_state: 'EVIDENCE_READY' });
    expect(fixture.db.prepare('SELECT consumed_at FROM leases').get()).not.toEqual({ consumed_at: null });
    expect(fixture.db.prepare('SELECT state, authoritative_status FROM jobs WHERE job_id = ?').get('job-1')).toEqual({
      state: 'EVIDENCE_READY',
      authoritative_status: null,
    });

    const duplicate = reportRun(fixture.db, audit, worker, {
      lease: dispatched.runtimeLeases[0]!.lease,
      verdict: 'PASS',
      summary: 'replayed',
    }, 'report-2', options);
    expect(duplicate).toMatchObject({ accepted: false, duplicate: true, status: 'SUCCEEDED' });
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
  });

  it('replays dispatch idempotency without creating another run', () => {
    const input = dispatchInput({ idempotency_key: '11111111-1111-4111-8111-111111111111' });
    const first = dispatchQa(fixture.db, audit, principal, input, 'dispatch-1', options);
    const second = dispatchQa(fixture.db, audit, principal, input, 'dispatch-2', options);
    expect(second.runtimeLeases).toHaveLength(0);
    expect(second).toMatchObject({ job_id: first.job_id, version: first.version, runs: first.runs });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM worker_runs').get()).toEqual({ count: 1 });
  });

  it('rejects stale, ineligible, and duplicate-worker dispatches without partial rows', () => {
    expect(() => dispatchQa(fixture.db, audit, principal, dispatchInput({ expected_version: 9 }), 'stale', options)).toThrow('version');
    expect(() => dispatchQa(fixture.db, audit, principal, dispatchInput({ requests: [
      { worker_id: 'fixture-worker', task: 'one' },
      { worker_id: 'fixture-worker', task: 'two' },
    ] }), 'duplicate', options)).toThrow('once');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM worker_runs').get()).toEqual({ count: 0 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM leases').get()).toEqual({ count: 0 });

    fixture.db.prepare('UPDATE jobs SET max_cycles = 0 WHERE job_id = ?').run('job-1');
    expect(() => dispatchQa(fixture.db, audit, principal, dispatchInput(), 'limit', options)).toThrow('cycle limit');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM worker_runs').get()).toEqual({ count: 0 });
  });

  it('rejects expired and mismatched worker reports without changing the run', () => {
    const dispatched = dispatchQa(fixture.db, audit, principal, dispatchInput({ requests: [{
      worker_id: 'fixture-worker', task: 'short', timeout_ms: 1_000,
    }] }), 'dispatch-expiry', options);
    const later: Phase6RunOptions = { ...options, clock: () => Date.parse('2026-08-31T00:00:02Z') };
    expect(() => reportRun(fixture.db, audit, worker, {
      lease: dispatched.runtimeLeases[0]!.lease, verdict: 'FAIL', summary: 'late',
    }, 'late-report', later)).toThrow('expired');
    expect(fixture.db.prepare('SELECT status FROM worker_runs').get()).toEqual({ status: 'PENDING' });

    const otherWorker = actor('other-worker', 'worker', ['work:report'], 'other-token');
    expect(() => reportRun(fixture.db, audit, otherWorker, {
      lease: dispatched.runtimeLeases[0]!.lease, verdict: 'PASS', summary: 'wrong actor',
    }, 'wrong-report', options)).toThrow('another worker');
    expect(fixture.db.prepare('SELECT consumed_at, status FROM leases JOIN worker_runs USING (run_id)').get()).toMatchObject({
      consumed_at: null,
      status: 'PENDING',
    });
  });

  it('settles multiple runs only after the final report', () => {
    fixture.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('worker-2', 'worker', 'Fixture Worker 2', '["work:report"]', 0, '2026-08-31T00:00:00Z');
    const twoWorkerOptions: Phase6RunOptions = { ...options, registry: {
      version: 1,
      workers: [...registry().workers, { ...registry('fixture-worker-2', 'worker-2').workers[0]! }],
    } };
    const dispatched = dispatchQa(fixture.db, audit, principal, dispatchInput({ requests: [
      { worker_id: 'fixture-worker', task: 'one' },
      { worker_id: 'fixture-worker-2', task: 'two' },
    ] }), 'dispatch-two', twoWorkerOptions);
    const first = dispatched.runtimeLeases[0]!;
    const second = dispatched.runtimeLeases[1]!;
    const firstWorker = reportRun(fixture.db, audit, worker, { lease: first.lease, verdict: 'PASS', summary: 'one' }, 'report-one', twoWorkerOptions);
    expect(firstWorker.job_state).toBe('QA_RUNNING');
    const secondWorker = actor('worker-2', 'worker', ['work:report'], 'worker-2-token');
    const final = reportRun(fixture.db, audit, secondWorker, { lease: second.lease, verdict: 'INCONCLUSIVE', summary: 'two' }, 'report-two', twoWorkerOptions);
    expect(final.job_state).toBe('EVIDENCE_READY');
    expect(fixture.db.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'system.runs_settled'").get()).toEqual({ count: 1 });
  });

  it('exposes bounded run status only to readers', () => {
    const dispatched = dispatchQa(fixture.db, audit, principal, dispatchInput(), 'status-dispatch', options);
    expect(listRunStatus(fixture.db, principal, { job_id: 'job-1' })).toHaveLength(1);
    expect(() => listRunStatus(fixture.db, worker, { job_id: 'job-1' })).toThrow('cannot read');
    expect(dispatched.runs[0]?.run_id).toBeTruthy();
  });

  it('cancels pending runs mechanically without changing job authority', () => {
    const dispatched = dispatchQa(fixture.db, audit, principal, dispatchInput(), 'cancel-dispatch', options);
    const cancelled = cancelRunsForJob(fixture.db, audit, 'job-1', 'cancel-request', options);
    expect(cancelled).toEqual([dispatched.runs[0]!.run_id]);
    expect(fixture.db.prepare('SELECT status, worker_verdict FROM worker_runs').get()).toEqual({
      status: 'CANCELLED',
      worker_verdict: 'NONE',
    });
    expect(fixture.db.prepare('SELECT state, authoritative_status FROM jobs WHERE job_id = ?').get('job-1')).toEqual({
      state: 'QA_RUNNING',
      authoritative_status: null,
    });
  });
});
