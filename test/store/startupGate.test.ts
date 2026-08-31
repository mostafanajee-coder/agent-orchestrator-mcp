import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import type { CommandContext } from '../../src/commands/context.js';
import { stateDirectories, stateLayout } from '../../src/config/stateRoot.js';
import { assertPhase1Ready } from '../../src/commands/startup.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';
import { createInMemoryTokenResolver } from '../../src/mcp/auth.js';
import { startHttpServer } from '../../src/mcp/http.js';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { startEnvironmentStdioServer } from '../../src/mcp/stdio.js';

let workspace: string;
let context: CommandContext;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'aom-phase3-startup-'));
  const root = join(workspace, 'state');
  const security = new FakeSecurityProvider();
  const layout = stateLayout(root, process.platform);
  for (const directory of stateDirectories(layout)) {
    mkdirSync(directory, { recursive: true });
    security.harden(directory, 'directory');
  }
  writeFileSync(layout.leaseKey, Buffer.alloc(32, 6));
  security.harden(layout.leaseKey, 'file');
  const cloudSync: CloudSyncEnvironment = {
    platform: process.platform,
    env: {},
    profileDir: workspace,
    readFileIfPresent: () => undefined,
  };
  context = {
    layout,
    security,
    cloudSync,
    platform: process.platform,
    legacyRoots: [],
  };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('serve startup Phase 3 gate', () => {
  it('fails closed before serving when the DB is absent', () => {
    expect(() => assertPhase1Ready(context)).toThrow(
      'MCP serve refused because Phase 3 database verification failed',
    );
    expect(() => requirePath(context.layout.database)).toThrow();
  });

  it('fails closed before serving when an existing DB is corrupt', () => {
    writeFileSync(context.layout.database, Buffer.from('not a SQLite database'));
    (context.security as FakeSecurityProvider).harden(context.layout.database, 'file');
    expect(() => assertPhase1Ready(context)).toThrow(
      'MCP serve refused because Phase 3 database verification failed',
    );
  });

  it('fails HTTP before creating or binding a server', () => {
    expect(() => startHttpServer({
      resolver: createInMemoryTokenResolver([]),
      version: '0.0.0-test',
      port: 0,
      verifyStartup: () => assertPhase1Ready(context),
    })).toThrow('Phase 3 database verification failed');
  });

  it('fails stdio before emitting protocol output', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    expect(() => startEnvironmentStdioServer({
      version: '0.0.0-test',
      environment: {},
      transport: new StdioServerTransport(input, output),
      verifyStartup: () => assertPhase1Ready(context),
    })).toThrow('Phase 3 database verification failed');
    expect(output.readableLength).toBe(0);
    input.destroy();
    output.destroy();
  });
});

function requirePath(path: string): Buffer {
  return readFileSync(path);
}
