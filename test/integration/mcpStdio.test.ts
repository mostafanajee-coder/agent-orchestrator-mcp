import { PassThrough } from 'node:stream';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createInMemoryTokenResolver,
  hashAccessToken,
} from '../../src/mcp/auth.js';
import {
  startAuthenticatedStdioServer,
  startEnvironmentStdioServer,
} from '../../src/mcp/stdio.js';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { ActorTokenRecord } from '../../src/mcp/auth.js';
import { SecurityError } from '../../src/errors.js';

const VALID_TOKEN = 'phase2-stdio-test-token';
const HANDLES: StdioServerHandle[] = [];

function tokenRecord(): ActorTokenRecord {
  return {
    tokenId: 'stdio-token',
    actorId: 'codex',
    tokenSha256: hashAccessToken(VALID_TOKEN),
    scopes: ['mcp'],
    sessionLabel: 'stdio-test',
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
  };
}

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

afterEach(async () => {
  while (HANDLES.length > 0) {
    const handle = HANDLES.pop();
    if (handle !== undefined) await handle.close();
  }
});

describe('official stdio transport over the shared MCP core', () => {
  it('authenticates once at startup and keeps stdout protocol-only', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const nextLine = lineReader(output);
    let startupChecks = 0;
    const handle = startEnvironmentStdioServer({
      version: '0.0.0-test',
      environment: { ORCHESTRATOR_ACTOR_TOKEN: VALID_TOKEN },
      transport: new StdioServerTransport(input, output),
      verifyStartup: () => { startupChecks += 1; },
    });
    HANDLES.push(handle);

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'phase2-test', version: '1' },
        },
      })}\n`,
    );
    const initialize = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect(initialize.result).toMatchObject({ serverInfo: { name: 'agent-orchestrator-mcp' } });

    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );
    const tools = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      'ping',
    ]);

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
      })}\n`,
    );
    const ping = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect(ping.result).toMatchObject({
      structuredContent: {
        ok: true,
        service: 'agent-orchestrator-mcp',
        transport: 'stdio',
        protocolEra: 'legacy',
      },
    });
    expect(JSON.stringify(initialize)).not.toContain(VALID_TOKEN);
    expect(JSON.stringify(tools)).not.toContain(VALID_TOKEN);
    expect(JSON.stringify(ping)).not.toContain(VALID_TOKEN);
    expect(startupChecks).toBe(1);
  });

  it('refuses before authentication and protocol output when startup verification fails', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let startupChecks = 0;

    expect(() =>
      startEnvironmentStdioServer({
        version: '0.0.0-test',
        environment: {},
        transport: new StdioServerTransport(input, output),
        verifyStartup: () => {
          startupChecks += 1;
          throw new SecurityError('Phase 1 state is not ready');
        },
      }),
    ).toThrow(SecurityError);
    expect(startupChecks).toBe(1);
    expect(output.readableLength).toBe(0);
  });

  it('refuses to start when the environment token is missing', () => {
    expect(() =>
      startEnvironmentStdioServer({
        version: '0.0.0-test',
        environment: {},
        verifyStartup: () => undefined,
      }),
    ).toThrow(/ORCHESTRATOR_ACTOR_TOKEN is required/);
  });

  it('refuses an invalid supplied token before creating a stdio handle', async () => {
    const resolver = createInMemoryTokenResolver([tokenRecord()]);
    await expect(
      startAuthenticatedStdioServer({
        resolver,
        token: 'not-the-fixture-token',
        version: '0.0.0-test',
        verifyStartup: () => undefined,
      }),
    ).rejects.toThrow('Invalid access token');
  });
});
