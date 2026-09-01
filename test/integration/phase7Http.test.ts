import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { AuditWriter } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { openPhase4Runtime, type Phase4Runtime } from '../../src/authority/runtime.js';
import { hashAccessToken } from '../../src/mcp/auth.js';
import { closeHttpServer, listenHttpServer, MCP_HTTP_HOST } from '../../src/mcp/http.js';
import { closeStoreFixture, createStoreFixture, seedJob, type StoreFixture } from '../store/testHelpers.js';

let fixture: StoreFixture;
let runtime: Phase4Runtime;
let endpoint: string;
let token: string;

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

beforeEach(async () => {
  fixture = createStoreFixture();
  const project = join(fixture.workspace, 'project');
  const initial = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
  if (initial === undefined) throw new Error('bootstrap did not return the test token');
  token = initial;
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?) ',
  ).run('worker', 'worker', 'HTTP Worker', '["artifact:register","evidence:add","work:report"]', 0, '2026-09-01T00:00:00Z');
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ',
  ).run('worker-token', 'worker', hashAccessToken('worker-secret'), 'worker', 0, null, null, '2026-09-01T00:00:00Z');
  seedJob(fixture.db, 'job-1', 'EVIDENCE_READY');
  fixture.db.prepare('UPDATE jobs SET workspace = ? WHERE job_id = ?').run(project, 'job-1');
  fixture.db.close();
  runtime = openPhase4Runtime(fixture.context);
  const server = await listenHttpServer({
    resolver: runtime.resolver,
    authority: {
      db: runtime.db,
      audit: runtime.audit,
      phase7: { artifactsRoot: fixture.layout.artifacts, platform: process.platform },
    },
    jobs: {
      db: runtime.db,
      audit: runtime.audit,
      workspaceRoots: [fixture.workspace],
      platform: process.platform,
      defaultMaxCycles: 2,
      hardMaxCycles: 3,
      defaultStaleAfterS: 60,
    },
    artifacts: {
      db: runtime.db,
      audit: runtime.audit,
      artifactsRoot: fixture.layout.artifacts,
      leaseKey: Buffer.alloc(32, 8),
    },
    version: '0.0.0-phase7-test',
    port: 0,
    verifyStartup: () => undefined,
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  endpoint = `http://${MCP_HTTP_HOST}:${(address as AddressInfo).port}/mcp`;
  (fixture as StoreFixture & { server?: typeof server }).server = server;
});

afterEach(async () => {
  const server = (fixture as StoreFixture & { server?: Server }).server;
  if (server !== undefined) await closeHttpServer(server);
  if (runtime !== undefined) runtime.close();
  if (fixture !== undefined) closeStoreFixture(fixture);
});

describe('Phase 7 HTTP surface', () => {
  it('exposes bounded evidence/artifact tools to the principal and mutations to a worker', async () => {
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
    const tools = (await responseJson(toolsResponse)).result as { tools: Array<{ name: string }> };
    expect(tools.tools.map((tool) => tool.name)).toContain('evidence_add');
    expect(tools.tools.map((tool) => tool.name)).toContain('artifact_register');
    expect(tools.tools.map((tool) => tool.name)).toContain('evidence_list');
    expect(tools.tools.map((tool) => tool.name)).toContain('artifact_list');
    expect(tools.tools.map((tool) => tool.name)).not.toContain('audit_query');

    const addResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rpc('evidence_add', {
        job_id: 'job-1',
        cycle: 0,
        kind: 'review',
        summary: 'HTTP evidence',
        idempotency_key: '5c6c7d8e-9f00-4111-8222-334455667788',
      }, 2),
    });
    expect((await responseJson(addResponse)).result).toMatchObject({ structuredContent: {
      ok: true,
      evidence: { trust: 'principal', source_actor: 'codex' },
    } });

    const listResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rpc('evidence_list', { job_id: 'job-1', limit: 10 }, 3),
    });
    expect((await responseJson(listResponse)).result).toMatchObject({ structuredContent: {
      ok: true,
      evidence: [{ summary: 'HTTP evidence' }],
    } });

    const workerToolsResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer worker-secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    const workerTools = (await responseJson(workerToolsResponse)).result as { tools: Array<{ name: string }> };
    expect(workerTools.tools.map((tool) => tool.name)).toContain('evidence_add');
    expect(workerTools.tools.map((tool) => tool.name)).toContain('artifact_register');
    expect(workerTools.tools.map((tool) => tool.name)).not.toContain('evidence_list');
    expect(workerTools.tools.map((tool) => tool.name)).not.toContain('artifact_list');
  });
});
