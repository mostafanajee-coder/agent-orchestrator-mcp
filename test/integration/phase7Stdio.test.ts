import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { AuditWriter } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { openPhase4Runtime, type Phase4Runtime } from '../../src/authority/runtime.js';
import { startAuthenticatedStdioServer } from '../../src/mcp/stdio.js';
import { closeStoreFixture, createStoreFixture, type StoreFixture } from '../store/testHelpers.js';

let fixture: StoreFixture;
let runtime: Phase4Runtime;
let token: string;
const handles: Array<Awaited<ReturnType<typeof startAuthenticatedStdioServer>>> = [];

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
  const initial = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
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

describe('Phase 7 stdio surface', () => {
  it('keeps the Phase 7 tool inventory aligned over stdio', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const nextLine = lineReader(output);
    const handle = await startAuthenticatedStdioServer({
      resolver: runtime.resolver,
      token,
      version: '0.0.0-phase7-test',
      transport: new StdioServerTransport(input, output),
      authority: { db: runtime.db, audit: runtime.audit },
      artifacts: {
        db: runtime.db,
        audit: runtime.audit,
        artifactsRoot: fixture.layout.artifacts,
        leaseKey: Buffer.alloc(32, 8),
      },
      verifyStartup: () => undefined,
    });
    handles.push(handle);

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase7-test', version: '1' } },
    })}\n`);
    await nextLine();
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const tools = JSON.parse(await nextLine()) as { result: { tools: Array<{ name: string }> } };
    const names = tools.result.tools.map((tool) => tool.name);
    expect(names).toEqual(['ping', 'codex_decide', 'evidence_add', 'artifact_register', 'evidence_list', 'artifact_list']);
    expect(names).not.toContain('audit_query');
    input.destroy();
    output.destroy();
  });
});
