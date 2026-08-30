import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createInMemoryTokenResolver,
  hashAccessToken,
} from '../../src/mcp/auth.js';
import {
  closeHttpServer,
  listenHttpServer,
  MCP_HTTP_HOST,
  startHttpServer,
} from '../../src/mcp/http.js';
import type { ActorTokenRecord } from '../../src/mcp/auth.js';
import type { HttpLogger } from '../../src/mcp/http.js';
import type { Server } from 'node:http';

const VALID_TOKEN = 'phase2-http-test-token';

function tokenRecord(): ActorTokenRecord {
  return {
    tokenId: 'http-token',
    actorId: 'codex',
    tokenSha256: hashAccessToken(VALID_TOKEN),
    scopes: ['mcp'],
    sessionLabel: 'http-test',
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
  };
}

function payload(body: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: body });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine === undefined ? body : dataLine.slice('data: '.length)) as Record<
    string,
    unknown
  >;
}

async function rawHttpRequest(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

describe('real loopback Streamable HTTP transport', () => {
  let server: Server;
  let endpoint: string;
  let loggerMessages: string[];

  beforeEach(async () => {
    loggerMessages = [];
    const logger: HttpLogger = { error: (message) => loggerMessages.push(message) };
    server = await listenHttpServer({
      resolver: createInMemoryTokenResolver([tokenRecord()]),
      version: '0.0.0-test',
      port: 0,
      logger,
      verifyStartup: () => undefined,
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    endpoint = `http://${MCP_HTTP_HOST}:${(address as AddressInfo).port}/mcp`;
  });

  afterEach(async () => {
    await closeHttpServer(server);
  });

  it('binds explicitly to 127.0.0.1', () => {
    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address === 'object' && address !== null ? address.address : '').toBe(
      MCP_HTTP_HOST,
    );
  });

  it('accepts valid localhost authentication and serves ping', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: payload({ name: 'ping', arguments: {} }),
    });

    expect(response.status).toBe(200);
    const result = await responseJson(response);
    expect(result.result).toMatchObject({
      structuredContent: {
        ok: true,
        service: 'agent-orchestrator-mcp',
        transport: 'http',
      },
    });
    expect(JSON.stringify(result)).not.toContain(VALID_TOKEN);
  });

  it('exposes only ping through tools/list', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const result = await responseJson(response);
    const tools = (result.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['ping']);
    expect(JSON.stringify(result)).not.toMatch(/job_create|codex_decide|audit_query/);
  });

  it('returns 401 for a missing bearer token', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: payload({ name: 'ping', arguments: {} }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(VALID_TOKEN);
  });

  it('returns 401 for an invalid bearer token', async () => {
    const invalid = 'phase2-invalid-http-token';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${invalid}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: payload({ name: 'ping', arguments: {} }),
    });

    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain(invalid);
    expect(text).not.toContain(VALID_TOKEN);
  });

  it('rejects a non-local Host with 403 before MCP handling', async () => {
    const response = await rawHttpRequest(
      endpoint,
      {
        host: 'attacker.example',
        authorization: `Bearer ${VALID_TOKEN}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      payload({ name: 'ping', arguments: {} }),
    );

    expect(response.status).toBe(403);
  });

  it('rejects a non-local Origin with 403', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example',
        authorization: `Bearer ${VALID_TOKEN}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: payload({ name: 'ping', arguments: {} }),
    });

    expect(response.status).toBe(403);
  });

  it('bounds the request body before passing it to the MCP transport', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: `{"padding":"${'x'.repeat(1_048_576)}"}`,
    });

    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain(VALID_TOKEN);
  });

  it('does not log a bearer token when the MCP layer reports an error', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'missing' } }),
    });

    expect(response.status).toBe(200);
    expect(loggerMessages.join('\n')).not.toContain(VALID_TOKEN);
  });
});

describe('HTTP startup gate', () => {
  it('refuses before creating or binding when startup verification fails', () => {
    let verified = false;
    expect(() =>
      startHttpServer({
        resolver: createInMemoryTokenResolver([tokenRecord()]),
        version: '0.0.0-test',
        port: 0,
        verifyStartup: () => {
          verified = true;
          throw new Error('startup verification failed');
        },
      }),
    ).toThrow('startup verification failed');
    expect(verified).toBe(true);
  });
});
