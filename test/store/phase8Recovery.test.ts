import { describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { openPhase4Runtime, type Phase4Runtime } from '../../src/authority/runtime.js';
import { applyTransition } from '../../src/domain/decide.js';
import { listAudit } from '../../src/domain/auditQuery.js';
import {
  Phase8Lifecycle,
  reapStaleRuns,
  recoverOrphanedRuns,
} from '../../src/domain/recovery.js';
import { closeStoreFixture, createStoreFixture, seedJob, type StoreFixture } from './testHelpers.js';

function addWorkerActor(fixture: StoreFixture): void {
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('worker', 'worker', 'Worker', '["work:report"]', 0, '2026-08-31T00:00:00Z');
}

function addActiveRun(
  fixture: StoreFixture,
  runId: string,
  jobId: string,
  options: { readonly state?: string; readonly updatedAt?: string; readonly expiresAt?: string; readonly status?: string } = {},
): void {
  seedJob(
    fixture.db,
    jobId,
    options.state ?? 'QA_RUNNING',
  );
  fixture.db.prepare('UPDATE jobs SET updated_at = ? WHERE job_id = ?').run(
    options.updatedAt ?? '2026-08-31T00:00:00Z',
    jobId,
  );
  fixture.db.prepare(
    'INSERT INTO worker_runs(run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, exit_code, pid, usage_json, stderr_tail, attempt, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    runId,
    jobId,
    0,
    'worker',
    'process',
    '{}',
    options.status ?? 'RUNNING',
    null,
    null,
    null,
    1234,
    null,
    null,
    1,
    '2026-08-31T00:00:00Z',
    null,
    '2026-08-31T00:00:00Z',
  );
  fixture.db.prepare(
    'INSERT INTO leases(lease_id, run_id, job_id, cycle, actor_id, nonce, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    `lease-${runId}`,
    runId,
    jobId,
    0,
    'worker',
    `nonce-${runId}`,
    options.expiresAt ?? '2026-08-31T00:10:00Z',
    null,
    '2026-08-31T00:00:00Z',
  );
}

function fixtureWithProduction(): StoreFixture {
  const fixture = createStoreFixture();
  bootstrapProduction(fixture.db, new AuditWriter(fixture.db), () => Date.parse('2026-08-31T00:00:00Z'));
  addWorkerActor(fixture);
  return fixture;
}

describe('Phase 8 recovery primitives', () => {
  it('runs startup recovery before a verified production runtime is returned', () => {
    const fixture = fixtureWithProduction();
    let runtime: Phase4Runtime | undefined;
    try {
      addActiveRun(fixture, 'run-startup', 'job-startup');
      fixture.db.close();
      runtime = openPhase4Runtime(fixture.context);
      expect(runtime.db.prepare('SELECT status FROM worker_runs WHERE run_id = ?').get('run-startup')).toEqual({ status: 'ORPHANED' });
      expect(runtime.db.prepare('SELECT state FROM jobs WHERE job_id = ?').get('job-startup')).toEqual({ state: 'STALLED' });
    } finally {
      runtime?.close();
      closeStoreFixture(fixture);
    }
  });

  it('reconciles previous active runs to ORPHANED and stalls QA without authority', () => {
    const fixture = fixtureWithProduction();
    try {
      addActiveRun(fixture, 'run-orphan', 'job-orphan');
      const audit = new AuditWriter(fixture.db, () => Date.parse('2026-08-31T00:00:10Z'));
      const result = recoverOrphanedRuns(fixture.db, audit, {
        clock: () => Date.parse('2026-08-31T00:00:10Z'),
        requestId: () => 'startup-recovery',
      });

      expect(result.reconciledRunIds).toEqual(['run-orphan']);
      expect(result.stalledJobIds).toEqual(['job-orphan']);
      expect(fixture.db.prepare('SELECT status, worker_verdict, ended_at FROM worker_runs WHERE run_id = ?').get('run-orphan')).toEqual({
        status: 'ORPHANED',
        worker_verdict: 'NONE',
        ended_at: '2026-08-31T00:00:10.000Z',
      });
      expect(fixture.db.prepare('SELECT state, state_reason, authoritative_status FROM jobs WHERE job_id = ?').get('job-orphan')).toEqual({
        state: 'STALLED',
        state_reason: 'startup_orphan',
        authoritative_status: null,
      });
      expect(fixture.db.prepare('SELECT consumed_at FROM leases WHERE run_id = ?').get('run-orphan')).toEqual({ consumed_at: null });
      expect(fixture.db.prepare(
        "SELECT action, subject_id FROM audit_log WHERE action IN ('run.orphaned', 'system.stall') ORDER BY seq",
      ).all()).toEqual([
        { action: 'run.orphaned', subject_id: 'run-orphan' },
        { action: 'system.stall', subject_id: 'job-orphan' },
      ]);
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
      expect(recoverOrphanedRuns(fixture.db, audit, { clock: () => Date.parse('2026-08-31T00:00:20Z') })).toMatchObject({
        examined: 0,
        reconciledRunIds: [],
        stalledJobIds: [],
      });
    } finally {
      closeStoreFixture(fixture);
    }
  });

  it('reaper times out expired owned runs and orphans runs without ownership', () => {
    const fixture = fixtureWithProduction();
    try {
      addActiveRun(fixture, 'run-timeout', 'job-timeout', { expiresAt: '2026-08-30T23:59:00Z' });
      addActiveRun(fixture, 'run-lost', 'job-lost');
      const audit = new AuditWriter(fixture.db, () => Date.parse('2026-08-31T00:01:00Z'));
      const stopped: Array<{ readonly runId: string; readonly outcome: string }> = [];
      const result = reapStaleRuns(fixture.db, audit, {
        clock: () => Date.parse('2026-08-31T00:01:00Z'),
        ownedRunIds: new Set(['run-timeout']),
        onReconciled: (runId, outcome): void => { stopped.push({ runId, outcome }); },
      });

      expect(result.reconciledRunIds).toEqual(['run-lost', 'run-timeout']);
      expect(stopped).toEqual([
        { runId: 'run-lost', outcome: 'ORPHANED' },
        { runId: 'run-timeout', outcome: 'TIMEOUT' },
      ]);
      expect(fixture.db.prepare('SELECT status, failure_class FROM worker_runs WHERE run_id = ?').get('run-timeout')).toEqual({
        status: 'TIMEOUT',
        failure_class: 'TIMEOUT',
      });
      expect(fixture.db.prepare('SELECT status FROM worker_runs WHERE run_id = ?').get('run-lost')).toEqual({ status: 'ORPHANED' });
      expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log WHERE action = ?').get('system.stall')).toEqual({ count: 2 });
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    } finally {
      closeStoreFixture(fixture);
    }
  });

  it('uses the job updated_at and stale_after_s contract for stale owned work', () => {
    const fixture = fixtureWithProduction();
    try {
      addActiveRun(fixture, 'run-stale', 'job-stale', {
        updatedAt: '2026-08-31T00:00:00Z',
        expiresAt: '2026-08-31T01:00:00Z',
      });
      const audit = new AuditWriter(fixture.db);
      const result = reapStaleRuns(fixture.db, audit, {
        clock: () => Date.parse('2026-08-31T00:02:00Z'),
        ownedRunIds: new Set(['run-stale']),
      });

      expect(result.reconciledRunIds).toEqual(['run-stale']);
      expect(fixture.db.prepare('SELECT status, failure_class FROM worker_runs WHERE run_id = ?').get('run-stale')).toEqual({
        status: 'TIMEOUT',
        failure_class: 'TIMEOUT',
      });
      expect(fixture.db.prepare('SELECT state, state_reason FROM jobs WHERE job_id = ?').get('job-stale')).toEqual({
        state: 'STALLED',
        state_reason: 'stale',
      });
    } finally {
      closeStoreFixture(fixture);
    }
  });

  it('completes mechanical cancellation after an authoritative cancel survives a crash', () => {
    const fixture = fixtureWithProduction();
    try {
      addActiveRun(fixture, 'run-cancel', 'job-cancel', { state: 'IN_PROGRESS' });
      const principal = {
        clientId: 'codex',
        scopes: ['mcp'],
        tokenId: 'token-initial',
        sessionLabel: 'codex-session',
        expiresAt: Number.MAX_SAFE_INTEGER,
        actorId: 'codex' as const,
        role: 'principal' as const,
        capabilities: ['job:decide', 'job:read'] as const,
      };
      applyTransition(
        fixture.db,
        new AuditWriter(fixture.db),
        principal,
        {
          jobId: 'job-cancel',
          cycle: 0,
          decision: 'CANCEL',
          rationale: 'cancel before simulated crash',
          expectedVersion: 1,
        },
        () => Date.parse('2026-08-31T00:01:00Z'),
      );
      const audit = new AuditWriter(fixture.db);
      const result = recoverOrphanedRuns(fixture.db, audit, {
        clock: () => Date.parse('2026-08-31T00:01:10Z'),
      });

      expect(result.reconciledRunIds).toEqual(['run-cancel']);
      expect(result.stalledJobIds).toEqual([]);
      expect(fixture.db.prepare('SELECT status FROM worker_runs WHERE run_id = ?').get('run-cancel')).toEqual({ status: 'CANCELLED' });
      expect(fixture.db.prepare('SELECT state, authoritative_status FROM jobs WHERE job_id = ?').get('job-cancel')).toEqual({
        state: 'JOB_CANCELLED',
        authoritative_status: 'JOB_CANCELLED',
      });
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    } finally {
      closeStoreFixture(fixture);
    }
  });

  it('reads a bounded redacted audit page and verifies only its range', () => {
    const fixture = fixtureWithProduction();
    try {
      const audit = new AuditWriter(fixture.db, () => Date.parse('2026-08-31T00:02:00Z'));
      audit.append({
        actorId: 'system',
        actorRole: 'system',
        requestId: 'audit-1',
        action: 'system.stall',
        result: 'ok',
        detail: { token: 'do-not-return', message: 'Bearer hidden-value' },
        timestamp: '2026-08-31T00:02:00Z',
      });
      audit.append({
        actorId: 'system',
        actorRole: 'system',
        requestId: 'audit-2',
        action: 'run.orphaned',
        result: 'ok',
        detail: { reason: 'startup_orphan' },
        timestamp: '2026-08-31T00:02:01Z',
      });
      const page = listAudit(fixture.db, { limit: 1, verify_range: true });
      expect(page.events).toHaveLength(1);
      expect(page.chain_valid).toBe(true);
      expect(page.next_cursor).toEqual(expect.any(String));
      expect(page.events[0]).toMatchObject({ action: 'run.orphaned', detail_truncated: false });
      if (page.next_cursor === undefined) throw new Error('expected an audit cursor');
      const previous = listAudit(fixture.db, { cursor: page.next_cursor, limit: 2 });
      expect(previous.events.map((event) => event.action)).toEqual(['system.stall', 'bootstrap.completed']);
      const detail = previous.events[0]?.detail_json ?? '';
      expect(detail).toContain('[REDACTED]');
      expect(detail).not.toContain('hidden-value');
      expect(detail).not.toContain('do-not-return');
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    } finally {
      closeStoreFixture(fixture);
    }
  });

  it('shuts down with a bounded runtime drain and reconciles remaining rows', async () => {
    const fixture = fixtureWithProduction();
    try {
      addActiveRun(fixture, 'run-shutdown', 'job-shutdown');
      const audit = new AuditWriter(fixture.db);
      let closed = false;
      const lifecycle = new Phase8Lifecycle({
        db: fixture.db,
        audit,
        shutdownDrainMs: 0,
        getOwnedRunIds: () => new Set(['run-shutdown']),
      });
      const result = await lifecycle.shutdown({
        activeRunIds: () => ['run-shutdown'],
        close: () => { closed = true; },
        waitForIdle: async () => false,
        stopRun: () => undefined,
      });
      expect(closed).toBe(true);
      expect(result.reconciledRunIds).toEqual(['run-shutdown']);
      expect(fixture.db.prepare('SELECT status FROM worker_runs WHERE run_id = ?').get('run-shutdown')).toEqual({ status: 'ORPHANED' });
      expect(lifecycle.isShuttingDown()).toBe(true);
    } finally {
      closeStoreFixture(fixture);
    }
  });
});
