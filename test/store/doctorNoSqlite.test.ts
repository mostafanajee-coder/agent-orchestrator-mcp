import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import type { CommandContext } from '../../src/commands/context.js';
import { stateDirectories, stateLayout } from '../../src/config/stateRoot.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';

let workspace: string | undefined;

function context(): CommandContext {
  workspace = mkdtempSync(join(tmpdir(), 'aom-phase3-doctor-opener-'));
  const root = join(workspace, 'state');
  const layout = stateLayout(root, process.platform);
  const security = new FakeSecurityProvider();
  for (const directory of stateDirectories(layout)) {
    mkdirSync(directory, { recursive: true });
    security.harden(directory, 'directory');
  }
  writeFileSync(layout.leaseKey, Buffer.alloc(32, 7));
  security.harden(layout.leaseKey, 'file');
  writeFileSync(layout.database, Buffer.from('metadata-only'));
  security.harden(layout.database, 'file');
  const cloudSync: CloudSyncEnvironment = {
    platform: process.platform,
    env: {},
    profileDir: workspace,
    readFileIfPresent: () => undefined,
  };
  return {
    layout,
    security,
    cloudSync,
    platform: process.platform,
    legacyRoots: [],
  };
}

afterEach(() => {
  vi.doUnmock('better-sqlite3');
  vi.resetModules();
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe('doctor database-opener boundary', () => {
  it('proves the injected SQLite opener is never called', async () => {
    vi.resetModules();
    const opener = vi.fn();
    vi.doMock('better-sqlite3', () => ({ default: opener }));
    const { runDoctor } = await import('../../src/commands/doctor.js');
    const report = runDoctor(context());

    expect(report.ok).toBe(true);
    expect(opener).not.toHaveBeenCalled();
    expect(report.checks.find(
      (check) => check.name === 'DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN',
    )?.status).toBe('warn');
  });
});
