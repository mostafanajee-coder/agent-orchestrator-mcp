import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { openPhase4Runtime, type Phase4Runtime } from '../../src/authority/runtime.js';
import {
  closeHttpServer,
  listenHttpServer,
  MCP_HTTP_HOST,
} from '../../src/mcp/http.js';
import {
  closeStoreFixture,
  createStoreFixture,
  type StoreFixture,
} from '../store/testHelpers.js';

let fixture: StoreFixture;
let runtime: Phase4Runtime;
let server: Server;
let endpoint: string;
let token: string;

function rpc(body: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: body });
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
  token = initial;
  fixture.db.close();
  runtime = openPhase4Runtime(fixture.context);
  server = await listenHttpServer({
    resolver: runtime.resolver,
    authority: runtime,
    version: '0.0.0-phase4-test',
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

describe('Phase 4 persistent loopback HTTP', () => {
  it('AUTH-01/REG-04 authenticates from actor_tokens and exposes only the approved Phase 4 tools', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: rpc({ name: 'ping', arguments: {} }),
    });
    expect(response.status).toBe(200);
    const result = await responseJson(response);
    expect(result.result).toMatchObject({
      structuredContent: { ok: true, service: 'agent-orchestrator-mcp', transport: 'http' },
    });

    const toolsResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const toolsResult = await responseJson(toolsResponse);
    expect((toolsResult.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      'ping',
      'codex_decide',
    ]);
  });

  it('AUTH-02 rejects an unknown bearer without reflecting it and records bounded metadata only', async () => {
    const invalid = 'phase4-http-invalid-token';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${invalid}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: rpc({ name: 'ping', arguments: {} }),
    });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(invalid);
    expect(runtime.db.prepare('SELECT count(*) AS count FROM audit_log WHERE action = ?').get('auth.rejected')).toEqual({ count: 1 });
    expect(verifyAuditChain(runtime.db)).toEqual({ valid: true });
  });
});
