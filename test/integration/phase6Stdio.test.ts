import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { openPhase4Runtime, type Phase4Runtime } from '../../src/authority/runtime.js';
import { hashAccessToken } from '../../src/mcp/auth.js';
import { startAuthenticatedStdioServer } from '../../src/mcp/stdio.js';
import { type Phase5JobToolOptions } from '../../src/mcp/tools/jobLifecycle.js';
import { type Phase6WorkerToolOptions } from '../../src/mcp/tools/phase6.js';
import { closeStoreFixture, createStoreFixture, type StoreFixture } from '../store/testHelpers.js';

let fixture: StoreFixture;
let runtime: Phase4Runtime;
let token: string;
let project: string;
const handles: StdioServerHandle[] = [];

function lineReader(stream: PassThrough): () => Promise<string> {
  let buffered = '';
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  stream.on('data', (chunk: Buffer | string) => {
    buffered += chunk.toString();
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line !== '') {
        const waiter = waiters.shift();
        if (waiter === undefined) lines.push(line);
        else waiter(line);
      }
      newline = buffered.indexOf('\n');
    }
  });
  return () => {
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise<string>((resolve) => waiters.push(resolve));
  };
}

function workerRegistry(): Phase6WorkerToolOptions['registry'] {
  return {
    version: 1,
    workers: [{
      worker_id: 'stdio-worker',
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

beforeEach(() => {
  fixture = createStoreFixture();
  project = join(fixture.workspace, 'project');
  mkdirSync(project);
  const initial = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
  if (initial === undefined) throw new Error('bootstrap did not return the test token');
  token = initial;
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('worker', 'worker', 'Stdio Worker', '["work:report"]', 0, '2026-08-31T00:00:00Z');
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('worker-token', 'worker', hashAccessToken('stdio-worker-secret'), 'stdio-worker', 0, null, null, '2026-08-31T00:00:00Z');
  fixture.db.close();
  runtime = openPhase4Runtime(fixture.context);
});

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.close();
  }
  if (runtime !== undefined) runtime.close();
  if (fixture !== undefined) closeStoreFixture(fixture);
});

describe('Phase 6 stdio surface', () => {
  it('keeps HTTP/stdio tool visibility aligned and dispatches a run', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const nextLine = lineReader(output);
    const jobs: Phase5JobToolOptions = {
      db: runtime.db,
      audit: runtime.audit,
      workspaceRoots: [fixture.workspace],
      platform: process.platform,
      defaultMaxCycles: 2,
      hardMaxCycles: 3,
      defaultStaleAfterS: 60,
    };
    const workers: Phase6WorkerToolOptions = {
      db: runtime.db,
      audit: runtime.audit,
      registry: workerRegistry(),
      leaseKey: Buffer.alloc(32, 6),
    };
    const handle = await startAuthenticatedStdioServer({
      resolver: runtime.resolver,
      token,
      version: '0.0.0-phase6-test',
      transport: new StdioServerTransport(input, output),
      authority: runtime,
      jobs,
      workers,
      verifyStartup: () => undefined,
    });
    handles.push(handle);

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase6-test', version: '1' } },
    })}\n`);
    const initialize = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect(initialize.result).toMatchObject({ serverInfo: { name: 'agent-orchestrator-mcp' } });

    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const tools = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
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

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'job_create',
        arguments: {
          title: 'stdio Phase 6 job',
          spec: { objective: 'exercise worker dispatch', acceptance_criteria: ['bounded run'] },
          workspace: project,
        },
      },
    })}\n`);
    const created = JSON.parse(await nextLine()) as Record<string, unknown>;
    const createdData = (created.result as { structuredContent: { job_id: string; version: number } }).structuredContent;

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'job_start', arguments: { job_id: createdData.job_id, expected_version: createdData.version } },
    })}\n`);
    const started = JSON.parse(await nextLine()) as { result: { structuredContent: { version: number } } };

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'qa_dispatch',
        arguments: {
          job_id: createdData.job_id,
          cycle: 0,
          expected_version: started.result.structuredContent.version,
          requests: [{ worker_id: 'stdio-worker', task: 'run task' }],
        },
      },
    })}\n`);
    const dispatched = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect(dispatched.result).toMatchObject({ structuredContent: { ok: true, state: 'QA_RUNNING', version: 3 } });
    expect(verifyAuditChain(runtime.db)).toEqual({ valid: true });
    input.destroy();
    output.destroy();
  });
});
