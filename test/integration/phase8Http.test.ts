import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { openPhase4Runtime, type Phase4Runtime } from '../../src/authority/runtime.js';
import { hashAccessToken } from '../../src/mcp/auth.js';
import { closeHttpServer, listenHttpServer, MCP_HTTP_HOST } from '../../src/mcp/http.js';
import { closeStoreFixture, createStoreFixture, type StoreFixture } from '../store/testHelpers.js';

let fixture: StoreFixture;
let runtime: Phase4Runtime;
let endpoint: string;
let principalToken: string;

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
  const initial = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
  if (initial === undefined) throw new Error('bootstrap did not return the test token');
  principalToken = initial;
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('worker', 'worker', 'Worker', '[]', 0, '2026-09-01T00:00:00Z');
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('worker-token', 'worker', hashAccessToken('worker-secret'), 'worker', 0, null, null, '2026-09-01T00:00:00Z');
  fixture.db.close();
  runtime = openPhase4Runtime(fixture.context);
  const server = await listenHttpServer({
    resolver: runtime.resolver,
    phase8: { db: runtime.db },
    version: '0.0.0-phase8-test',
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

describe('Phase 8 HTTP audit query surface', () => {
  it('exposes bounded audit_query only to the Codex principal', async () => {
    const headers = {
      authorization: `Bearer ${principalToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const toolsResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const tools = (await responseJson(toolsResponse)).result as { tools: Array<{ name: string }> };
    expect(tools.tools.map((tool) => tool.name)).toEqual(['ping', 'audit_query']);

    const queryResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rpc('audit_query', { limit: 10, verify_range: true }, 2),
    });
    const query = await responseJson(queryResponse);
    expect(query.result).toMatchObject({ structuredContent: {
      ok: true,
      chain_valid: true,
      events: [{ seq: 1, action: 'bootstrap.completed', actor_role: 'system' }],
    } });

    const workerResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer worker-secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    const workerTools = (await responseJson(workerResponse)).result as { tools: Array<{ name: string }> };
    expect(workerTools.tools.map((tool) => tool.name)).toEqual(['ping']);
  });
});
