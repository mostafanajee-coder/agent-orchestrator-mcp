import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { AuditWriter } from '../../src/authority/audit.js';
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

function pingRequest(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'ping', arguments: {} },
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine === undefined ? body : dataLine.slice('data: '.length)) as Record<string, unknown>;
}

async function start(corruptState: boolean): Promise<void> {
  fixture = createStoreFixture();
  const initialToken = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
  if (initialToken === undefined) throw new Error('bootstrap did not create a token');
  token = initialToken;
  if (corruptState) {
    writeFileSync(fixture.layout.authorizationStateFile, '{not-json', 'utf8');
    fixture.security.harden(fixture.layout.authorizationStateFile, 'file');
  }
  fixture.db.close();
  runtime = openPhase4Runtime(fixture.context);
  server = await listenHttpServer({
    resolver: runtime.resolver,
    authority: runtime,
    version: '0.0.0-phase10b3a-test',
    port: 0,
    verifyStartup: () => undefined,
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  endpoint = `http://${MCP_HTTP_HOST}:${(address as AddressInfo).port}/mcp`;
}

afterEach(async () => {
  if (server !== undefined) await closeHttpServer(server);
  if (runtime !== undefined) runtime.close();
  if (fixture !== undefined) closeStoreFixture(fixture);
});

describe('Phase 10B.3A direct-read isolation', () => {
  beforeEach(async () => start(false));

  it('serves direct ping while external authorization state is uninitialized', async () => {
    expect(runtime.authorizationReadiness.readiness).toBe('UNINITIALIZED');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: pingRequest(),
    });
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
  });
});

describe('Phase 10B.3A corrupt-state isolation', () => {
  beforeEach(async () => start(true));

  it('serves direct ping while external authorization state is corrupt', async () => {
    expect(runtime.authorizationReadiness.readiness).toBe('INVALID');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: pingRequest(),
    });
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
  });
});
