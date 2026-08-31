import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { openPhase4Runtime, type Phase4Runtime } from '../../src/authority/runtime.js';
import { hashAccessToken } from '../../src/mcp/auth.js';
import { dispatchQa } from '../../src/domain/runs.js';
import { createJob, startJob } from '../../src/domain/jobs.js';
import { closeHttpServer, listenHttpServer, MCP_HTTP_HOST } from '../../src/mcp/http.js';
import { type Phase5JobToolOptions } from '../../src/mcp/tools/jobLifecycle.js';
import { type Phase6WorkerToolOptions } from '../../src/mcp/tools/phase6.js';
import { closeStoreFixture, createStoreFixture, type StoreFixture } from '../store/testHelpers.js';

let fixture: StoreFixture;
let runtime: Phase4Runtime;
let server: Server;
let endpoint: string;
let token: string;
let project: string;
let jobs: Phase5JobToolOptions;
let workers: Phase6WorkerToolOptions;

function rpc(name: string, args: Record<string, unknown>, id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine === undefined ? body : dataLine.slice('data: '.length)) as Record<string, unknown>;
}

function workerRegistry(): Phase6WorkerToolOptions['registry'] {
  return {
    version: 1,
    workers: [{
      worker_id: 'http-worker',
      actor_id: 'worker',
      enabled: true,
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
    }],
  };
}

beforeEach(async () => {
  fixture = createStoreFixture();
  project = join(fixture.workspace, 'project');
  mkdirSync(project);
  const initial = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
  if (initial === undefined) throw new Error('bootstrap did not return the test token');
  token = initial;
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('worker', 'worker', 'HTTP Worker', '["work:report"]', 0, '2026-08-31T00:00:00Z');
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('worker-token', 'worker', hashAccessToken('http-worker-secret'), 'http-worker', 0, null, null, '2026-08-31T00:00:00Z');
  fixture.db.close();
  runtime = openPhase4Runtime(fixture.context);
  jobs = {
    db: runtime.db,
    audit: runtime.audit,
    workspaceRoots: [fixture.workspace],
    platform: process.platform,
    defaultMaxCycles: 2,
    hardMaxCycles: 3,
    defaultStaleAfterS: 60,
  };
  workers = {
    db: runtime.db,
    audit: runtime.audit,
    registry: workerRegistry(),
    leaseKey: Buffer.alloc(32, 4),
  };
  server = await listenHttpServer({
    resolver: runtime.resolver,
    authority: runtime,
    jobs,
    workers,
    version: '0.0.0-phase6-test',
    port: 0,
    verifyStartup: () => undefined,
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  endpoint = `http://${MCP_HTTP_HOST}:${(address as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  if (server !== undefined) await closeHttpServer(server);
  if (runtime !== undefined) runtime.close();
  if (fixture !== undefined) closeStoreFixture(fixture);
});

describe('Phase 6 HTTP surface', () => {
  it('exposes the three Phase 6 tools and dispatches a non-authoritative run', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const toolsResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const toolsResult = await responseJson(toolsResponse);
    expect((toolsResult.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      'ping',
      'codex_decide',
      'job_create',
      'job_start',
      'job_resume',
      'job_get',
      'job_list',
      'qa_dispatch',
      'run_status',
    ]);

    const createResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rpc('job_create', {
        title: 'HTTP Phase 6 job',
        spec: { objective: 'exercise worker dispatch', acceptance_criteria: ['bounded run'] },
        workspace: project,
      }, 2),
    });
    const created = await responseJson(createResponse);
    const createdData = (created.result as { structuredContent: { job_id: string; version: number } }).structuredContent;

    const startResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rpc('job_start', { job_id: createdData.job_id, expected_version: createdData.version }, 3),
    });
    const started = (await responseJson(startResponse)).result as { structuredContent: { version: number } };

    const dispatchResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rpc('qa_dispatch', {
        job_id: createdData.job_id,
        cycle: 0,
        expected_version: started.structuredContent.version,
        requests: [{ worker_id: 'http-worker', task: 'run task' }],
      }, 4),
    });
    const dispatched = await responseJson(dispatchResponse);
    const data = (dispatched.result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(data).toMatchObject({ ok: true, state: 'QA_RUNNING', version: 3 });
    expect(data).not.toHaveProperty('lease');
    expect((data['runs'] as unknown[])).toHaveLength(1);
    expect(verifyAuditChain(runtime.db)).toEqual({ valid: true });

    const workerToolsResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer http-worker-secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    });
    const workerTools = await responseJson(workerToolsResponse);
    expect((workerTools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      'ping',
      'run_report',
    ]);
  });

  it('accepts a worker report only through its run lease', async () => {
    const principal = runtime.resolver.verifyAccessTokenSync(token);
    const created = createJob(
      runtime.db,
      runtime.audit,
      principal,
      {
        title: 'HTTP report job',
        spec: { objective: 'exercise report ingress', acceptance_criteria: ['one report'] },
        workspace: project,
      },
      'http-report-create',
      jobs,
    );
    const started = startJob(
      runtime.db,
      runtime.audit,
      principal,
      { job_id: created.job_id, expected_version: created.version },
      'http-report-start',
      jobs,
    );
    const dispatched = dispatchQa(runtime.db, runtime.audit, principal, {
      job_id: started.job_id,
      cycle: 0,
      expected_version: started.version,
      requests: [{ worker_id: 'http-worker', task: 'report task' }],
    }, 'http-report-dispatch', workers);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer http-worker-secret',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: rpc('run_report', {
        lease: dispatched.runtimeLeases[0]!.lease,
        verdict: 'PASS',
        summary: 'worker completed',
      }, 9),
    });
    const body = await responseJson(response);
    expect(body.result).toMatchObject({ structuredContent: {
      ok: true,
      accepted: true,
      status: 'SUCCEEDED',
      job_state: 'EVIDENCE_READY',
    } });
    expect(verifyAuditChain(runtime.db)).toEqual({ valid: true });
  });
});
