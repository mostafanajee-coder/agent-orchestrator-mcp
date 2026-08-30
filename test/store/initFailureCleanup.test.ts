import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import type { CommandContext } from '../../src/commands/context.js';
import { stateDirectories, stateLayout } from '../../src/config/stateRoot.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';
import { initializeDatabaseForInit } from '../../src/store/init.js';
import { discoverMigrations, type Migration } from '../../src/store/migrations.js';

let workspace: string;
let context: CommandContext;

function createContext(): CommandContext {
  workspace = mkdtempSync(join(tmpdir(), 'aom-phase3-init-failure-'));
  const root = join(workspace, 'state');
  const security = new FakeSecurityProvider();
  const layout = stateLayout(root, process.platform);
  for (const directory of stateDirectories(layout)) {
    mkdirSync(directory, { recursive: true });
    security.harden(directory, 'directory');
  }
  writeFileSync(layout.leaseKey, Buffer.alloc(32, 7));
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

function migrationsWithFailure(version: number): readonly Migration[] {
  return discoverMigrations().map((migration) => migration.version === version
    ? { ...migration, sql: 'THIS IS NOT VALID SQL;' }
    : migration);
}

beforeEach(() => {
  context = createContext();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('fresh init failure cleanup', () => {
  it.each([1, 2])(
    'preserves the migration %d failure, removes every DB sidecar, and retries normally',
    (failedVersion) => {
      let failure: unknown;
      try {
        initializeDatabaseForInit(context, {
          migrations: migrationsWithFailure(failedVersion),
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/near "THIS"|syntax error/i);
      for (const path of [
        context.layout.database,
        context.layout.databaseWal,
        context.layout.databaseShm,
      ]) {
        expect(existsSync(path)).toBe(false);
      }

      const retry = initializeDatabaseForInit(context);
      expect(retry).toEqual({
        created: true,
        schemaVersion: 4,
        appliedVersions: [1, 2, 3, 4],
      });
    },
  );
});
