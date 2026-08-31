import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
let project: string;

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
  project = join(fixture.workspace, 'project');
  mkdirSync(project);
  const initial = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
  if (initial === undefined) throw new Error('bootstrap did not return the test token');
  token = initial;
  fixture.db.close();
  runtime = openPhase4Runtime(fixture.context);
  server = await listenHttpServer({
    resolver: runtime.resolver,
    authority: runtime,
    jobs: {
      db: runtime.db,
      audit: runtime.audit,
      workspaceRoots: [fixture.workspace],
      platform: process.platform,
      defaultMaxCycles: 2,
      hardMaxCycles: 3,
      defaultStaleAfterS: 60,
    },
    version: '0.0.0-phase5-test',
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

describe('Phase 5 persistent loopback HTTP', () => {
  it('exposes and executes the authorized lifecycle surface over HTTP', async () => {
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
    expect(toolsResponse.status).toBe(200);
    const toolsResult = await responseJson(toolsResponse);
    expect((toolsResult.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      'ping',
      'codex_decide',
      'job_create',
      'job_start',
      'job_resume',
      'job_get',
      'job_list',
    ]);

    const createResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rpc({
        name: 'job_create',
        arguments: {
          title: 'HTTP Phase 5 job',
          spec: { objective: 'exercise HTTP lifecycle', acceptance_criteria: ['bounded response'] },
          workspace: project,
        },
      }, 2),
    });
    const created = await responseJson(createResponse);
    const createdContent = (created.result as { structuredContent: { job_id: string; version: number; state: string; request_id: string } }).structuredContent;
    expect(createdContent).toMatchObject({ state: 'CREATED', version: 1 });
    expect(createdContent.request_id).toMatch(/^[0-9a-f-]{36}$/i);

    const startResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: rpc({
        name: 'job_start',
        arguments: { job_id: createdContent.job_id, expected_version: createdContent.version },
      }, 3),
    });
    const started = await responseJson(startResponse);
    expect(started.result).toMatchObject({ structuredContent: { ok: true, state: 'IN_PROGRESS', version: 2 } });
    expect(verifyAuditChain(runtime.db)).toEqual({ valid: true });
  });
});
