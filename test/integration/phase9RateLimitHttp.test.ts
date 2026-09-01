import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { RequestRateLimiter } from '../../src/mcp/admission.js';
import { createInMemoryTokenResolver, hashAccessToken } from '../../src/mcp/auth.js';
import { closeHttpServer, listenHttpServer, MCP_HTTP_HOST, MCP_HTTP_PATH } from '../../src/mcp/http.js';

let server: Server | undefined;

function request(token: string, body: string): Promise<Response> {
  const address = server?.address();
  if (address === undefined || address === null || typeof address === 'string') {
    throw new Error('server did not bind');
  }
  return fetch(`http://${MCP_HTTP_HOST}:${(address as AddressInfo).port}${MCP_HTTP_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body,
  });
}

afterEach(async () => {
  if (server !== undefined) await closeHttpServer(server);
  server = undefined;
});

describe('Phase 9 HTTP request admission', () => {
  it('charges authenticated tools/list and rejects before body parsing when exhausted', async () => {
    const token = 'phase9-http-token';
    const resolver = createInMemoryTokenResolver([{
      tokenId: 'phase9-token-a',
      actorId: 'codex',
      tokenSha256: hashAccessToken(token),
      scopes: ['mcp'],
      sessionLabel: 'phase9-a',
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    }]);
    const limiter = new RequestRateLimiter({ capacity: 1, clock: () => 1_000_000 });
    server = await listenHttpServer({
      resolver,
      rateLimiter: limiter,
      version: '0.0.0-phase9-rate-test',
      port: 0,
      verifyStartup: () => undefined,
    });

    const first = await request(token, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    expect(first.status).toBe(200);
    const second = await request(token, '{invalid json that must not be parsed}');
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
    expect(await second.text()).toContain('RATE_LIMITED');
  });
});
