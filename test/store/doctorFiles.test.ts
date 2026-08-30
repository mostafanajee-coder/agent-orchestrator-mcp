import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import type { CommandContext } from '../../src/commands/context.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { stateDirectories, stateLayout, type StateLayout } from '../../src/config/stateRoot.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';

let workspace: string;
let context: CommandContext;

function createContext(withDatabase: boolean, withSidecars: boolean): CommandContext {
  workspace = mkdtempSync(join(tmpdir(), 'aom-phase3-doctor-'));
  const root = join(workspace, 'state');
  const security = new FakeSecurityProvider();
  const layout = stateLayout(root, process.platform);
  for (const directory of stateDirectories(layout)) {
    mkdirSync(directory, { recursive: true });
    security.harden(directory, 'directory');
  }
  writeFileSync(layout.leaseKey, Buffer.alloc(32, 5));
  security.harden(layout.leaseKey, 'file');

  if (withDatabase) {
    writeFileSync(layout.database, Buffer.from('database-metadata-only'));
    security.harden(layout.database, 'file');
    if (withSidecars) {
      writeFileSync(layout.databaseWal, Buffer.from('wal-metadata-only'));
      writeFileSync(layout.databaseShm, Buffer.from('shm-metadata-only'));
      security.harden(layout.databaseWal, 'file');
      security.harden(layout.databaseShm, 'file');
    }
  }

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

function snapshot(layout: StateLayout): Record<string, { size: number; mtimeMs: number; sha256: string }> {
  return Object.fromEntries(
    readdirSync(layout.data, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const path = join(layout.data, entry.name);
        const stat = lstatSync(path);
        return [
          entry.name,
          {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
          },
        ];
      }),
  );
}

beforeEach(() => {
  context = createContext(true, true);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('filesystem-only doctor', () => {
  it('reports the explicit SQL-not-checked status without SQLite', () => {
    const report = runDoctor(context);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'DB_FILE_SECURITY')?.detail).toContain(
      'DB_FILE_SECURITY=PASS',
    );
    expect(report.checks.find(
      (check) => check.name === 'DB_SQL_INTEGRITY=NOT_CHECKED_BY_DESIGN',
    )?.status).toBe('warn');
  });

  it('does not mutate DB/WAL/SHM metadata or create files', () => {
    const before = snapshot(context.layout);
    runDoctor(context);
    const after = snapshot(context.layout);
    expect(after).toEqual(before);
  });

  it('reports an absent DB without creating it', () => {
    context = createContext(false, false);
    const report = runDoctor(context);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'DB_FILE_SECURITY')?.detail).toContain(
      'DB_FILE_SECURITY=ABSENT',
    );
    expect(lstatSync(context.layout.data).isDirectory()).toBe(true);
    expect(() => lstatSync(context.layout.database)).toThrow();
  });
});
