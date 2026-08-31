import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { applyTransition } from '../../src/domain/decide.js';
import {
  createJob,
  getJob,
  JobLifecycleError,
  listJobs,
  resumeJob,
  startJob,
  type JobCreateInput,
  type JobLifecycleOptions,
} from '../../src/domain/jobs.js';
import { hashAccessToken, createSdkTokenVerifier, type VerifiedActorAuthInfo } from '../../src/mcp/auth.js';
import { createMcpServerFactory } from '../../src/mcp/server.js';
import { createPersistentTokenResolver } from '../../src/mcp/persistentAuth.js';
import {
  closeStoreFixture,
  createStoreFixture,
  type StoreFixture,
} from './testHelpers.js';

let fixture: StoreFixture;
let audit: AuditWriter;
let token: string;
let project: string;

function options(overrides: Partial<JobLifecycleOptions> = {}): JobLifecycleOptions {
  return {
    workspaceRoots: [fixture.workspace],
    platform: process.platform,
    defaultMaxCycles: 2,
    hardMaxCycles: 3,
    defaultStaleAfterS: 60,
    clock: () => Date.parse('2026-08-31T00:00:00.000Z'),
    ...overrides,
  };
}

function input(overrides: Partial<JobCreateInput> = {}): JobCreateInput {
  return {
    title: 'Phase 5 job',
    spec: {
      objective: 'Implement the bounded job lifecycle.',
      acceptance_criteria: ['The lifecycle is atomic and auditable.'],
    },
    workspace: project,
    ...overrides,
  };
}

function auth(): VerifiedActorAuthInfo {
  return createPersistentTokenResolver(fixture.db).verifyAccessTokenSync(token);
}

function request(body: unknown): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  if (dataLine === undefined) throw new Error(`MCP response did not contain data: ${body}`);
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

beforeEach(() => {
  fixture = createStoreFixture();
  project = join(fixture.workspace, 'project');
  mkdirSync(project);
  audit = new AuditWriter(fixture.db);
  const bootstrap = bootstrapProduction(fixture.db, audit);
  if (bootstrap.initialToken === undefined) throw new Error('bootstrap did not return an initial token');
  token = bootstrap.initialToken;
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('Phase 5 job lifecycle domain', () => {
  it('creates an admitted non-authoritative job with server-owned defaults', () => {
    const job = createJob(fixture.db, audit, auth(), input(), 'create-1', options());

    expect(job).toMatchObject({
      workspace: realpathSync.native(project),
      state: 'CREATED',
      authoritative_status: null,
      deciding_decision_id: null,
      owner_actor_id: 'codex',
      cycle: 0,
      max_cycles: 2,
      version: 1,
      stale_after_s: 60,
    });
    expect(fixture.db.prepare('SELECT state, authoritative_status, deciding_decision_id, version FROM jobs WHERE job_id = ?').get(job.job_id)).toEqual({
      state: 'CREATED',
      authoritative_status: null,
      deciding_decision_id: null,
      version: 1,
    });
    expect(fixture.db.prepare('SELECT action, session_token_id, to_state FROM audit_log WHERE action = ?').get('job.create')).toEqual({
      action: 'job.create',
      session_token_id: 'token-initial',
      to_state: 'CREATED',
    });
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
  });

  it('rejects a configured root and an outside directory before any write', () => {
    const rootOptions = options({ workspaceRoots: [project] });
    const beforeJobs = fixture.db.prepare('SELECT count(*) AS count FROM jobs').get();
    const beforeAudit = fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get();
    const beforeIdempotency = fixture.db.prepare('SELECT count(*) AS count FROM idempotency').get();

    expect(() => createJob(fixture.db, audit, auth(), input({ workspace: project }), 'root', rootOptions))
      .toThrowError(new JobLifecycleError('WORKSPACE_NOT_ALLOWED', 'The workspace is outside the configured workspace roots.'));
    expect(() => createJob(fixture.db, audit, auth(), input({ workspace: fixture.workspace }), 'outside', rootOptions))
      .toThrow(JobLifecycleError);
    expect(() => createJob(fixture.db, audit, auth(), input({ workspace: `relative-${project}` }), 'relative', rootOptions))
      .toThrow(JobLifecycleError);
    expect(() => createJob(
      fixture.db,
      audit,
      auth(),
      input({ workspace: `${project}${process.platform === 'win32' ? '\\' : '/'}..${process.platform === 'win32' ? '\\' : '/'}project` }),
      'traversal',
      rootOptions,
    )).toThrow(JobLifecycleError);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual(beforeJobs);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get()).toEqual(beforeAudit);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM idempotency').get()).toEqual(beforeIdempotency);
  });

  it('replays the same create request and does not hash server-owned defaults', () => {
    const key = '11111111-1111-4111-8111-111111111111';
    const first = createJob(fixture.db, audit, auth(), input({ idempotency_key: key }), 'create-first', options({ defaultMaxCycles: 2 }));
    const replay = createJob(
      fixture.db,
      audit,
      auth(),
      input({ idempotency_key: key, session_hint: 'different-decoration' }),
      'create-replay',
      options({ defaultMaxCycles: 3 }),
    );

    expect(replay).toEqual(first);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log WHERE action = ?').get('job.create')).toEqual({ count: 1 });
    expect(() => createJob(
      fixture.db,
      audit,
      auth(),
      input({ idempotency_key: key, title: 'different request' }),
      'create-conflict',
      options(),
    )).toThrowError(new JobLifecycleError('IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different request.'));
  });

  it('starts and resumes only their declared states without changing cycle', () => {
    const created = createJob(fixture.db, audit, auth(), input(), 'create-start', options());
    const started = startJob(fixture.db, audit, auth(), {
      job_id: created.job_id,
      expected_version: created.version,
    }, 'start-1', options());
    expect(started).toMatchObject({ state: 'IN_PROGRESS', cycle: 0, version: 2 });

    fixture.db.prepare(
      'UPDATE jobs SET state = ?, cycle = ?, version = ?, state_reason = ? WHERE job_id = ?',
    ).run('REPAIR', 1, 3, 'fix', created.job_id);
    const resumed = resumeJob(fixture.db, audit, auth(), {
      job_id: created.job_id,
      expected_version: 3,
    }, 'resume-1', options());
    expect(resumed).toMatchObject({ state: 'IN_PROGRESS', cycle: 1, version: 4 });
    expect(fixture.db.prepare('SELECT action, from_state, to_state, cycle FROM audit_log WHERE action IN (?, ?) ORDER BY seq').all('job.start', 'job.resume')).toEqual([
      { action: 'job.start', from_state: 'CREATED', to_state: 'IN_PROGRESS', cycle: 0 },
      { action: 'job.resume', from_state: 'REPAIR', to_state: 'IN_PROGRESS', cycle: 1 },
    ]);
  });

  it('rejects stale lifecycle writes, enforces the hard cycle limit, and reaches APPROVED without workers', () => {
    const tooLarge = input({ max_cycles: 4, title: 'Too large' });
    expect(() => createJob(fixture.db, audit, auth(), tooLarge, 'too-large', options()))
      .toThrowError(new JobLifecycleError('INVALID_INPUT', 'max_cycles exceeds hard_max_cycles.'));

    const created = createJob(fixture.db, audit, auth(), input({ title: 'Approve without workers' }), 'create-approve', options());
    const beforeAudit = fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get();
    expect(() => startJob(fixture.db, audit, auth(), {
      job_id: created.job_id,
      expected_version: 99,
    }, 'stale-start', options())).toThrowError(
      new JobLifecycleError('STATE_CONFLICT', 'The job version changed before the lifecycle operation was applied.'),
    );
    expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get()).toEqual(beforeAudit);
    expect(fixture.db.prepare('SELECT state, version FROM jobs WHERE job_id = ?').get(created.job_id)).toEqual({
      state: 'CREATED',
      version: 1,
    });

    const started = startJob(fixture.db, audit, auth(), {
      job_id: created.job_id,
      expected_version: created.version,
    }, 'start-approve', options());
    const approved = applyTransition(fixture.db, audit, auth(), {
      jobId: created.job_id,
      cycle: 0,
      decision: 'APPROVE',
      rationale: 'The lifecycle integration gate is satisfied.',
      expectedVersion: started.version,
      requestId: 'approve-without-workers',
    });
    expect(approved).toMatchObject({ state: 'APPROVED', authoritativeStatus: 'APPROVED', version: 3 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM worker_runs').get()).toEqual({ count: 0 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM leases').get()).toEqual({ count: 0 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM decisions WHERE job_id = ?').get(created.job_id)).toEqual({ count: 1 });
  });

  it('increments a normal FIX cycle once and records the max-cycle guard without exceeding the limit', () => {
    const created = createJob(fixture.db, audit, auth(), input({ max_cycles: 2 }), 'create-fix', options());
    fixture.db.prepare('UPDATE jobs SET state = ? WHERE job_id = ?').run('EVIDENCE_READY', created.job_id);
    const fixed = applyTransition(fixture.db, audit, auth(), {
      jobId: created.job_id,
      cycle: 0,
      decision: 'FIX',
      rationale: 'A bounded repair cycle is required.',
      expectedVersion: 1,
      requestId: 'fix-1',
    });
    expect(fixed).toMatchObject({ state: 'REPAIR', cycle: 1, version: 2 });
    const resumed = resumeJob(fixture.db, audit, auth(), {
      job_id: created.job_id,
      expected_version: 2,
    }, 'resume-after-fix', options());
    expect(resumed).toMatchObject({ state: 'IN_PROGRESS', cycle: 1, version: 3 });

    const exhausted = createJob(fixture.db, audit, auth(), input({ max_cycles: 2, title: 'Exhausted job' }), 'create-exhausted', options());
    fixture.db.prepare(
      'UPDATE jobs SET state = ?, cycle = ?, version = ? WHERE job_id = ?',
    ).run('EVIDENCE_READY', 2, 1, exhausted.job_id);
    const guarded = applyTransition(fixture.db, audit, auth(), {
      jobId: exhausted.job_id,
      cycle: 2,
      decision: 'RETEST',
      rationale: 'The cycle budget is exhausted.',
      expectedVersion: 1,
      requestId: 'limit-1',
    });
    expect(guarded).toMatchObject({
      state: 'STALLED',
      authoritativeStatus: null,
      cycle: 2,
      version: 2,
    });
    expect(fixture.db.prepare('SELECT state, state_reason, cycle, authoritative_status FROM jobs WHERE job_id = ?').get(exhausted.job_id)).toEqual({
      state: 'STALLED',
      state_reason: 'max_cycles',
      cycle: 2,
      authoritative_status: null,
    });
    expect(fixture.db.prepare('SELECT decision, from_state, to_state FROM decisions WHERE job_id = ?').get(exhausted.job_id)).toEqual({
      decision: 'RETEST',
      from_state: 'EVIDENCE_READY',
      to_state: 'STALLED',
    });
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
  });

  it('returns bounded reads, rejects future collections, and enforces cursor binding', () => {
    const first = createJob(fixture.db, audit, auth(), input({ title: 'first' }), 'create-first', options());
    createJob(fixture.db, audit, auth(), input({ title: 'second' }), 'create-second', options());
    const details = getJob(fixture.db, auth(), { job_id: first.job_id, include: ['decisions'] });
    expect(details.decisions).toEqual([]);
    expect(() => getJob(fixture.db, auth(), { job_id: first.job_id, include: ['runs'] }))
      .toThrowError(new JobLifecycleError('UNSUPPORTED_COLLECTION', 'runs, evidence, and artifacts are not available in Phase 5.'));

    const page = listJobs(fixture.db, auth(), { limit: 1 }, options());
    expect(page.jobs).toHaveLength(1);
    expect(listJobs(fixture.db, auth(), { workspace: project }, options()).jobs).toHaveLength(2);
    expect(() => listJobs(fixture.db, auth(), { limit: 101 }, options())).toThrow(JobLifecycleError);
    if (page.next_cursor === undefined) throw new Error('expected a next cursor');
    const next = listJobs(fixture.db, auth(), { limit: 1, cursor: page.next_cursor }, options());
    expect(next.jobs).toHaveLength(1);
    expect(next.jobs[0]?.job_id).not.toBe(page.jobs[0]?.job_id);
    expect(() => listJobs(fixture.db, auth(), { state: 'IN_PROGRESS', cursor: page.next_cursor }, options()))
      .toThrowError(new JobLifecycleError('INVALID_INPUT', 'The cursor is invalid or belongs to different filters.'));
    expect(() => listJobs(fixture.db, auth(), { cursor: 'not-a-cursor' }, options()))
      .toThrow(JobLifecycleError);
    expect(listJobs(fixture.db, auth(), { authoritative_status: null }, options()).jobs.length).toBe(2);
  });

  it('returns JOB_NOT_FOUND and denies workers at both domain and registration layers', async () => {
    expect(() => getJob(fixture.db, auth(), { job_id: 'missing-job' })).toThrowError(
      new JobLifecycleError('JOB_NOT_FOUND', 'The requested job was not found.'),
    );

    fixture.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('worker', 'worker', 'Worker', '["job:read"]', 0, '2026-08-31T00:00:00Z');
    const workerToken = 'phase5-worker-token';
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('worker-token', 'worker', hashAccessToken(workerToken), 'worker-session', 0, null, null, '2026-08-31T00:00:00Z');
    const worker = createPersistentTokenResolver(fixture.db, { audit }).verifyAccessTokenSync(workerToken);
    expect(() => getJob(fixture.db, worker, { job_id: 'missing-job' })).toThrowError(
      new JobLifecycleError('AUTHORIZATION_DENIED', 'The verified actor cannot read job lifecycle data.'),
    );
    expect(() => listJobs(fixture.db, worker, {}, options())).toThrowError(
      new JobLifecycleError('AUTHORIZATION_DENIED', 'The verified actor cannot read job lifecycle data.'),
    );

    const handler = createMcpHandler(
      createMcpServerFactory({
        transport: 'http',
        version: '0.0.0-test',
        jobs: { db: fixture.db, audit, ...options() },
      }),
      { legacy: 'stateless', responseMode: 'json' },
    );
    try {
      const workerAuth = await createSdkTokenVerifier(createPersistentTokenResolver(fixture.db, { audit }))
        .verifyAccessToken(workerToken);
      const response = await handler.fetch(
        request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { authInfo: workerAuth },
      );
      const payload = await responsePayload(response);
      expect((payload.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(['ping']);
    } finally {
      await handler.close();
    }
  });
});

describe('Phase 5 MCP surface', () => {
  it('exposes lifecycle tools only to the verified principal and read tools to an observer', async () => {
    const resolver = createPersistentTokenResolver(fixture.db, { audit });
    const principalAuth = await createSdkTokenVerifier(resolver).verifyAccessToken(token);
    const handler = createMcpHandler(
      createMcpServerFactory({
        transport: 'http',
        version: '0.0.0-test',
        authority: { db: fixture.db, audit },
        jobs: { db: fixture.db, audit, ...options() },
      }),
      { legacy: 'stateless', responseMode: 'json' },
    );

    try {
      const toolsResponse = await handler.fetch(
        request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { authInfo: principalAuth },
      );
      const toolsPayload = await responsePayload(toolsResponse);
      expect((toolsPayload.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
        'ping',
        'codex_decide',
        'job_create',
        'job_start',
        'job_resume',
        'job_get',
        'job_list',
      ]);

      const createResponse = await handler.fetch(
        request({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'job_create',
            arguments: {
              title: 'MCP job',
              spec: { objective: 'exercise MCP', acceptance_criteria: ['bounded result'] },
              workspace: project,
            },
          },
        }),
        { authInfo: principalAuth },
      );
      const createPayload = await responsePayload(createResponse);
      expect(createPayload.result).toMatchObject({ structuredContent: { ok: true, state: 'CREATED', version: 1 } });
    } finally {
      await handler.close();
    }

    fixture.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('observer', 'observer', 'Observer', '["job:read"]', 0, '2026-08-31T00:00:00Z');
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('observer-token', 'observer', hashAccessToken('observer-token'), 'observer-session', 0, null, null, '2026-08-31T00:00:00Z');
    const observerAuth = await createSdkTokenVerifier(resolver).verifyAccessToken('observer-token');
    const observerHandler = createMcpHandler(
      createMcpServerFactory({
        transport: 'http',
        version: '0.0.0-test',
        jobs: { db: fixture.db, audit, ...options() },
      }),
      { legacy: 'stateless', responseMode: 'json' },
    );
    try {
      const toolsResponse = await observerHandler.fetch(
        request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
        { authInfo: observerAuth },
      );
      const toolsPayload = await responsePayload(toolsResponse);
      expect((toolsPayload.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
        'ping',
        'job_get',
        'job_list',
      ]);
    } finally {
      await observerHandler.close();
    }
  });
});
