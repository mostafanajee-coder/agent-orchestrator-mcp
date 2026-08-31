import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { hashAccessToken, type VerifiedActorAuthInfo } from '../../src/mcp/auth.js';
import { dispatchQa, listRunStatus, type Phase6RunOptions } from '../../src/domain/runs.js';
import { ProcessRuntime } from '../../src/workers/processRuntime.js';
import { closeStoreFixture, createStoreFixture, seedJob, type StoreFixture } from '../store/testHelpers.js';

let fixture: StoreFixture;
let audit: AuditWriter;
let principal: VerifiedActorAuthInfo;
let options: Phase6RunOptions;
const runtimes: ProcessRuntime[] = [];

function registry(script: string, timeout = 300_000): Phase6RunOptions['registry'] {
  return {
    version: 1,
    workers: [{
      worker_id: 'process-worker',
      actor_id: 'worker',
      enabled: true,
      adapter: 'process',
      delivery: 'pipe',
      executable: process.execPath,
      argv_template: ['-e', script],
      cwd_policy: 'job_workspace',
      environment_allowlist: [],
      default_timeout_ms: timeout,
      hard_timeout_ms: 900_000,
      max_output_bytes: 4 * 1024 * 1024,
      max_messages: 256,
    }],
  };
}

async function waitForTerminal(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = fixture.db.prepare('SELECT state FROM jobs WHERE job_id = ?').get(jobId) as { readonly state?: string };
    if (state.state === 'EVIDENCE_READY') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  fixture = createStoreFixture();
  audit = new AuditWriter(fixture.db);
  bootstrapProduction(fixture.db, audit);
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('worker', 'worker', 'Process Worker', '["work:report"]', 0, '2026-08-31T00:00:00Z');
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('worker-token', 'worker', hashAccessToken('worker-secret'), 'worker', 0, null, null, '2026-08-31T00:00:00Z');
  seedJob(fixture.db, 'job-1', 'IN_PROGRESS');
  fixture.db.prepare('UPDATE jobs SET workspace = ? WHERE job_id = ?').run(fixture.workspace, 'job-1');
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
    registry: registry("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'result',verdict:'PASS',summary:'done'}) + '\\n'));"),
    leaseKey: Buffer.alloc(32, 9),
    clock: () => Date.parse('2026-08-31T00:00:00Z'),
  };
});

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()?.close();
  closeStoreFixture(fixture);
});

describe('Phase 6 process runtime', () => {
  it('runs a bounded local process and settles through the shared path', async () => {
    const dispatched = dispatchQa(fixture.db, audit, principal, {
      job_id: 'job-1',
      cycle: 0,
      expected_version: 1,
      requests: [{ worker_id: 'process-worker', task: 'execute' }],
    }, 'dispatch-runtime', options);
    const runtime = new ProcessRuntime({ db: fixture.db, audit, ...options });
    runtimes.push(runtime);
    runtime.startRuns(dispatched.runtimeLeases);
    await waitForTerminal('job-1');
    const runs = listRunStatus(fixture.db, principal, { job_id: 'job-1' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'SUCCEEDED', worker_verdict: 'PASS' });
    expect(fixture.db.prepare('SELECT state, authoritative_status FROM jobs WHERE job_id = ?').get('job-1')).toEqual({
      state: 'EVIDENCE_READY',
      authoritative_status: null,
    });
  });

  it('maps a non-result process to MALFORMED without approval', async () => {
    const runtimeOptions: Phase6RunOptions = {
      ...options,
      registry: registry("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"),
    };
    const dispatched = dispatchQa(fixture.db, audit, principal, {
      job_id: 'job-1',
      cycle: 0,
      expected_version: 1,
      requests: [{ worker_id: 'process-worker', task: 'malformed' }],
    }, 'dispatch-malformed', runtimeOptions);
    const runtime = new ProcessRuntime({ db: fixture.db, audit, ...runtimeOptions });
    runtimes.push(runtime);
    runtime.startRuns(dispatched.runtimeLeases);
    await waitForTerminal('job-1');
    expect(fixture.db.prepare('SELECT status, worker_verdict FROM worker_runs').get()).toEqual({
      status: 'MALFORMED',
      worker_verdict: 'NONE',
    });
  });

  it('maps a runtime deadline to TIMEOUT without authority status', async () => {
    const runtimeOptions: Phase6RunOptions = {
      ...options,
      registry: registry("process.stdin.resume(); setTimeout(() => {}, 5000);", 1_000),
    };
    const dispatched = dispatchQa(fixture.db, audit, principal, {
      job_id: 'job-1',
      cycle: 0,
      expected_version: 1,
      requests: [{ worker_id: 'process-worker', task: 'timeout' }],
    }, 'dispatch-timeout', runtimeOptions);
    const runtime = new ProcessRuntime({ db: fixture.db, audit, ...runtimeOptions });
    runtimes.push(runtime);
    runtime.startRuns(dispatched.runtimeLeases);
    await waitForTerminal('job-1');
    expect(fixture.db.prepare('SELECT status, worker_verdict FROM worker_runs').get()).toEqual({
      status: 'TIMEOUT',
      worker_verdict: 'NONE',
    });
  });

  it('redacts bearer-like values from the retained stderr tail', async () => {
    const runtimeOptions: Phase6RunOptions = {
      ...options,
      registry: registry("process.stderr.write('Bearer private-value\\n'); process.stdout.write(JSON.stringify({type:'result',verdict:'PASS',summary:'done'}) + '\\n');"),
    };
    const dispatched = dispatchQa(fixture.db, audit, principal, {
      job_id: 'job-1',
      cycle: 0,
      expected_version: 1,
      requests: [{ worker_id: 'process-worker', task: 'redact' }],
    }, 'dispatch-redact', runtimeOptions);
    const runtime = new ProcessRuntime({ db: fixture.db, audit, ...runtimeOptions });
    runtimes.push(runtime);
    runtime.startRuns(dispatched.runtimeLeases);
    await waitForTerminal('job-1');
    const row = fixture.db.prepare('SELECT stderr_tail FROM worker_runs').get() as { readonly stderr_tail?: string | null };
    expect(row.stderr_tail).toContain('Bearer [REDACTED]');
    expect(row.stderr_tail).not.toContain('private-value');
  });
});
