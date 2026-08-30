import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import {
  createInMemoryTokenResolver,
  createSdkTokenVerifier,
  hashAccessToken,
} from '../../src/mcp/auth.js';
import { createMcpServerFactory } from '../../src/mcp/server.js';
import type { ActorTokenRecord } from '../../src/mcp/auth.js';

const TOKEN = 'phase2-server-test-token';
const VERSION = '0.0.0-test';

function authRecord(): ActorTokenRecord {
  return {
    tokenId: 'server-token',
    actorId: 'codex',
    tokenSha256: hashAccessToken(TOKEN),
    scopes: ['mcp'],
    sessionLabel: 'server-test',
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
  };
}

function request(body: unknown): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  if (dataLine === undefined) throw new Error(`MCP response did not contain data: ${body}`);
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

async function sdkAuth(): Promise<Awaited<ReturnType<ReturnType<typeof createSdkTokenVerifier>['verifyAccessToken']>>> {
  const resolver = createInMemoryTokenResolver([authRecord()]);
  return createSdkTokenVerifier(resolver).verifyAccessToken(TOKEN);
}

describe('shared MCP server factory', () => {
  it('exposes only ping and returns the bounded HTTP result', async () => {
    const handler = createMcpHandler(
      createMcpServerFactory({ transport: 'http', version: VERSION }),
      { legacy: 'stateless', responseMode: 'json' },
    );
    const authInfo = await sdkAuth();

    try {
      const toolsResponse = await handler.fetch(
        request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { authInfo },
      );
      const toolsPayload = await responsePayload(toolsResponse);
      const toolsResult = toolsPayload.result as { tools: Array<{ name: string }> };
      expect(toolsResult.tools.map((tool) => tool.name)).toEqual(['ping']);

      const pingResponse = await handler.fetch(
        request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
        { authInfo },
      );
      const pingPayload = await responsePayload(pingResponse);
      expect(pingPayload.result).toMatchObject({
        structuredContent: {
          ok: true,
          service: 'agent-orchestrator-mcp',
          transport: 'http',
          protocolEra: 'legacy',
        },
      });
      expect(JSON.stringify(pingPayload)).not.toContain(TOKEN);
    } finally {
      await handler.close();
    }
  });

  it('uses the same tool definition with stdio transport identity', async () => {
    const authInfo = await sdkAuth();
    const handler = createMcpHandler(
      createMcpServerFactory({
        transport: 'stdio',
        version: VERSION,
        staticAuthInfo: {
          clientId: authInfo.clientId,
          scopes: authInfo.scopes,
          tokenId: 'stdio-token',
          sessionLabel: 'stdio-test',
          expiresAt: authInfo.expiresAt ?? 0,
        },
      }),
      { legacy: 'stateless', responseMode: 'json' },
    );

    try {
      const response = await handler.fetch(request({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
      }));
      const payload = await responsePayload(response);
      expect(payload.result).toMatchObject({
        structuredContent: {
          ok: true,
          transport: 'stdio',
          protocolEra: 'legacy',
        },
      });
    } finally {
      await handler.close();
    }
  });
});
