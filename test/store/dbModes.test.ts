import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import type { CommandContext } from '../../src/commands/context.js';
import {
  closeDatabase,
  openDatabaseForInit,
  openExistingDatabaseForServe,
} from '../../src/store/db.js';
import { runMigrations } from '../../src/store/migrations.js';
import { verifyDatabaseIntegrity } from '../../src/store/integrity.js';
import { stateDirectories, stateLayout } from '../../src/config/stateRoot.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';

let workspace: string;
let context: CommandContext;

function createBaseContext(): CommandContext {
  workspace = mkdtempSync(join(tmpdir(), 'aom-phase3-db-modes-'));
  const root = join(workspace, 'state');
  const security = new FakeSecurityProvider();
  const layout = stateLayout(root, process.platform);
  for (const directory of stateDirectories(layout)) {
    mkdirSync(directory, { recursive: true });
    security.harden(directory, 'directory');
  }
  writeFileSync(layout.leaseKey, Buffer.alloc(32, 8));
  security.harden(layout.leaseKey, 'file');
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

beforeEach(() => {
  context = createBaseContext();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('secure database open modes', () => {
  it('serve is existing-only and does not invoke the opener for a missing DB', () => {
    const opener = vi.fn();
    expect(() => openExistingDatabaseForServe(context, { opener })).toThrow(
      'authoritative database',
    );
    expect(opener).not.toHaveBeenCalled();
    expect(existsSync(context.layout.database)).toBe(false);
  });

  it('init creates, hardens, migrates, and verifies the exact DB after parent security', () => {
    const opened = openDatabaseForInit(context);
    try {
      expect(opened.fresh).toBe(true);
      expect(existsSync(context.layout.database)).toBe(true);
      const security = context.security as FakeSecurityProvider;
      expect(security.hardened.findIndex(
        (call) => call.path === context.layout.data,
      )).toBeLessThan(security.hardened.findIndex(
        (call) => call.path === context.layout.database,
      ));
      runMigrations(opened.db, { fresh: true });
      expect(verifyDatabaseIntegrity(opened.db).schemaVersion).toBe(4);
      expect(opened.db.pragma('recursive_triggers', { simple: true })).toBe(1);
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('existing init opens the authoritative DB without classifying it as fresh', () => {
    const first = openDatabaseForInit(context);
    closeDatabase(first.db);
    const second = openDatabaseForInit(context);
    try {
      expect(second.fresh).toBe(false);
    } finally {
      closeDatabase(second.db);
    }
  });

  it('serve rejects an unsafe existing sidecar before SQLite opens', () => {
    writeFileSync(context.layout.database, Buffer.from('database'));
    context.security.harden(context.layout.database, 'file');
    writeFileSync(context.layout.databaseWal, Buffer.from('unsafe-sidecar'));
    const opener = vi.fn();

    expect(() => openExistingDatabaseForServe(context, { opener })).toThrow(
      'not protected',
    );
    expect(opener).not.toHaveBeenCalled();
  });
});
