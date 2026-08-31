import { PassThrough } from 'node:stream';

import { StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction as runBootstrap } from '../../src/authority/bootstrap.js';
import { openPhase4Runtime, type Phase4Runtime } from '../../src/authority/runtime.js';
import { createPersistentTokenResolver } from '../../src/mcp/persistentAuth.js';
import { startAuthenticatedStdioServer } from '../../src/mcp/stdio.js';
import { closeStoreFixture, createStoreFixture, type StoreFixture } from '../store/testHelpers.js';

let fixture: StoreFixture;
let runtime: Phase4Runtime;
let token: string;
const handles: StdioServerHandle[] = [];

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

beforeEach(() => {
  fixture = createStoreFixture();
  const initial = runBootstrap(fixture.db, new AuditWriter(fixture.db)).initialToken;
  if (initial === undefined) throw new Error('bootstrap did not return the test token');
  token = initial;
  fixture.db.close();
  runtime = openPhase4Runtime(fixture.context);
});

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.close();
  }
  if (runtime !== undefined) runtime.close();
  if (fixture !== undefined) closeStoreFixture(fixture);
});

describe('Phase 4 persistent stdio', () => {
  it('AUTH-03 authenticates before protocol output and exposes the approved tool inventory', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const nextLine = lineReader(output);
    const handle = await startAuthenticatedStdioServer({
      resolver: runtime.resolver,
      token,
      version: '0.0.0-phase4-test',
      transport: new StdioServerTransport(input, output),
      authority: runtime,
      verifyStartup: () => undefined,
    });
    handles.push(handle);

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })}\n`);
    const initialize = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect(initialize.result).toMatchObject({ serverInfo: { name: 'agent-orchestrator-mcp' } });

    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const tools = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      'ping',
      'codex_decide',
    ]);
  });

  it('AUTH-04 rejects an invalid persistent token before stdio output', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const resolver = createPersistentTokenResolver(runtime.db, { audit: runtime.audit });
    await expect(startAuthenticatedStdioServer({
      resolver,
      token: 'phase4-invalid-stdio-token',
      version: '0.0.0-phase4-test',
      transport: new StdioServerTransport(input, output),
      authority: runtime,
      verifyStartup: () => undefined,
    })).rejects.toThrow('Invalid access token');
    expect(output.readableLength).toBe(0);
    expect(verifyAuditChain(runtime.db)).toEqual({ valid: true });
    input.destroy();
    output.destroy();
  });
});
