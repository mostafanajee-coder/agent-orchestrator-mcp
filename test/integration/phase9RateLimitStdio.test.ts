import { PassThrough } from 'node:stream';

import { StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { RequestRateLimiter } from '../../src/mcp/admission.js';
import { createInMemoryTokenResolver, hashAccessToken } from '../../src/mcp/auth.js';
import { startAuthenticatedStdioServer } from '../../src/mcp/stdio.js';

let handle: StdioServerHandle | undefined;

function nextLine(stream: PassThrough): () => Promise<string> {
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
  if (handle !== undefined) await handle.close();
  handle = undefined;
});

describe('Phase 9 stdio request admission', () => {
  it('charges the authenticated opening and rejects a later request before dispatch', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const readLine = nextLine(output);
    const token = 'phase9-stdio-token';
    const resolver = createInMemoryTokenResolver([{
      tokenId: 'phase9-stdio-a',
      actorId: 'codex',
      tokenSha256: hashAccessToken(token),
      scopes: ['mcp'],
      sessionLabel: 'stdio-a',
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    }]);
    handle = await startAuthenticatedStdioServer({
      resolver,
      token,
      version: '0.0.0-phase9-stdio-rate-test',
      transport: new StdioServerTransport(input, output),
      rateLimiter: new RequestRateLimiter({ capacity: 2, clock: () => 0 }),
      verifyStartup: () => undefined,
    });

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rate-test', version: '1' } },
    })}\n`);
    expect(JSON.parse(await readLine())).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'agent-orchestrator-mcp' } } });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    expect(JSON.parse(await readLine())).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32029,
        data: { code: 'RATE_LIMITED', retry_after_ms: 1_000 },
      },
    });
    input.destroy();
    output.destroy();
  });
});
