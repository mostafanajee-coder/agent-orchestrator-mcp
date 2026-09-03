import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '../../src/commands/context.js';
import type { Phase4ManagementRuntime } from '../../src/authority/runtime.js';
import {
  AUTHORIZATION_EPOCH_BYTES,
  AUTHORIZATION_STATE_VERSION,
  AuthorizationStateManager,
  CLOCK_ROLLBACK_TOLERANCE_MS,
  createAuthorizationStateDocument,
  inspectAuthorizationState,
  parseAuthorizationState,
  readAuthorizationStateDocument,
  serializeAuthorizationState,
  writeAuthorizationState,
  type AuthorizationStateFileSystem,
  type AuthorizationStateOptions,
} from '../../src/authority/authorizationState.js';
import {
  runAuthorityStateCommand,
  type AuthorityStateCommandDependencies,
} from '../../src/commands/authorityState.js';
import { stateLayout } from '../../src/config/stateRoot.js';
import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import { SecurityError } from '../../src/errors.js';
import { FakeSecurityProvider } from '../../test/helpers/fakeSecurity.js';

function realFileSystem(): AuthorizationStateFileSystem {
  return {
    exists: existsSync,
    lstat: (path) => {
      const stats: Stats = lstatSync(path);
      return { size: stats.size, nlink: stats.nlink };
    },
    read: (path) => readFileSync(path, 'utf8'),
    open: (path, flags, mode) => mode === undefined ? openSync(path, flags) : openSync(path, flags, mode),
    write: writeSync,
    fsync: fsyncSync,
    close: closeSync,
    rename: renameSync,
    unlink: unlinkSync,
  };
}

let workspace: string;
let root: string;
let security: FakeSecurityProvider;
let options: AuthorizationStateOptions;
let nowMs: number;

function stateContext(): CommandContext {
  const cloudSync: CloudSyncEnvironment = {
    platform: process.platform,
    env: {},
    profileDir: workspace,
    readFileIfPresent: () => undefined,
  };
  return {
    layout: stateLayout(root, process.platform),
    security,
    cloudSync,
    platform: process.platform,
    legacyRoots: [],
  };
}

function makeDocument(epochByte = 1, clock = nowMs): ReturnType<typeof createAuthorizationStateDocument> {
  return createAuthorizationStateDocument(clock, () => Buffer.alloc(AUTHORIZATION_EPOCH_BYTES, epochByte));
}

function writeInitial(epochByte = 1, clock = nowMs): void {
  writeAuthorizationState(
    { ...options, replace: false },
    makeDocument(epochByte, clock),
  );
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'aomcp-authority-state-'));
  root = join(workspace, 'state');
  mkdirSync(root, { recursive: true });
  security = new FakeSecurityProvider();
  security.harden(root, 'directory');
  nowMs = Date.parse('2026-09-03T10:00:00.000Z');
  options = {
    path: join(root, 'authorization-state.v1.json'),
    security,
    platform: process.platform,
    clock: () => nowMs,
  };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('authorization state format', () => {
  it('creates and reloads the exact v1 document without exposing raw state through status', () => {
    writeInitial();

    expect(JSON.parse(readFileSync(options.path, 'utf8'))).toEqual({
      version: AUTHORIZATION_STATE_VERSION,
      authorization_epoch: '01'.repeat(32),
      clock_high_water_ms: nowMs,
    });
    expect(readAuthorizationStateDocument(options)).toEqual({
      version: AUTHORIZATION_STATE_VERSION,
      authorization_epoch: '01'.repeat(32),
      clock_high_water_ms: nowMs,
    });
    const status = inspectAuthorizationState(options, nowMs);
    expect(status.readiness).toBe('READY');
    expect(status.epochFingerprint).not.toContain('01'.repeat(32));
  });

  it('rejects missing, extra, malformed, and coerced fields', () => {
    expect(() => parseAuthorizationState(null)).toThrow(SecurityError);
    expect(() => parseAuthorizationState({
      version: 1,
      authorization_epoch: '01'.repeat(32),
      clock_high_water_ms: nowMs,
      extra: true,
    })).toThrow('missing or unexpected fields');
    expect(() => parseAuthorizationState({
      version: '1',
      authorization_epoch: '01'.repeat(32),
      clock_high_water_ms: nowMs,
    })).toThrow('unsupported');
    expect(() => parseAuthorizationState({
      version: 1,
      authorization_epoch: '01'.repeat(31),
      clock_high_water_ms: nowMs,
    })).toThrow('epoch is malformed');
    expect(() => parseAuthorizationState({
      version: 1,
      authorization_epoch: 'GG'.repeat(32),
      clock_high_water_ms: nowMs,
    })).toThrow('epoch is malformed');
    expect(() => parseAuthorizationState({
      version: 1,
      authorization_epoch: '01'.repeat(32),
      clock_high_water_ms: 1.5,
    })).toThrow('clock high-water');
    expect(() => parseAuthorizationState({
      version: 1,
      authorization_epoch: '01'.repeat(32),
      clock_high_water_ms: -1,
    })).toThrow('clock high-water');
    expect(() => parseAuthorizationState({
      version: 2,
      authorization_epoch: '01'.repeat(32),
      clock_high_water_ms: nowMs,
    })).toThrow('unsupported');
  });

  it('maps a missing file to UNINITIALIZED without creating it', () => {
    const status = inspectAuthorizationState(options, nowMs);
    expect(status).toMatchObject({ readiness: 'UNINITIALIZED' });
    expect(existsSync(options.path)).toBe(false);
  });

  it('maps malformed or insecure files to INVALID without automatic repair', () => {
    writeFileSyncForTest(options.path, '{not-json');
    const malformed = inspectAuthorizationState(options, nowMs);
    expect(malformed.readiness).toBe('INVALID');

    rmSync(options.path);
    writeFileSyncForTest(options.path, serializeAuthorizationState(makeDocument()));
    security.forcedInsecure.add(options.path);
    const insecure = inspectAuthorizationState(options, nowMs);
    expect(insecure.readiness).toBe('INVALID');
    expect(readFileSync(options.path, 'utf8')).toContain('authorization_epoch');
  });
});

describe('authorization clock guard', () => {
  it('pins tolerated rollback to the ceiling and rejects larger rollback', () => {
    writeInitial();
    const tolerated = inspectAuthorizationState(options, nowMs - CLOCK_ROLLBACK_TOLERANCE_MS);
    expect(tolerated.readiness).toBe('READY');
    expect(tolerated.effectiveNowMs).toBe(nowMs);

    const rejected = inspectAuthorizationState(options, nowMs - CLOCK_ROLLBACK_TOLERANCE_MS - 1);
    expect(rejected.readiness).toBe('CLOCK_ROLLBACK');
    expect(rejected.clockHighWaterMs).toBe(nowMs);
  });

  it('defeats cumulative sub-threshold rollback from the persisted ceiling', () => {
    writeInitial();
    expect(inspectAuthorizationState(options, nowMs - 4_000).readiness).toBe('READY');
    expect(inspectAuthorizationState(options, nowMs - 8_000).readiness).toBe('CLOCK_ROLLBACK');
  });

  it('advances high-water before future authority work and preserves the serializer after failure', async () => {
    writeInitial();
    const manager = new AuthorizationStateManager(options);
    const advanced = await manager.persistHighWaterBeforeAuthorityWork(nowMs + 1_000);
    expect(advanced.clockHighWaterMs).toBe(nowMs + 1_000);
    expect(readAuthorizationStateDocument(options).clock_high_water_ms).toBe(nowMs + 1_000);

    let failNextRename = true;
    const originalRename = realFileSystem().rename;
    const failingFileSystem: AuthorizationStateFileSystem = {
      ...realFileSystem(),
      rename: (source, target) => {
      if (failNextRename) {
        failNextRename = false;
        const error = new Error('simulated rename refusal') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      originalRename(source, target);
      },
    };
    const failingManager = new AuthorizationStateManager({ ...options, fileSystem: failingFileSystem });
    await expect(failingManager.persistHighWaterBeforeAuthorityWork(nowMs + 2_000)).rejects.toThrow(SecurityError);
    const later = await failingManager.persistHighWaterBeforeAuthorityWork(nowMs + 3_000);
    expect(later.readiness).toBe('READY');
    expect(readAuthorizationStateDocument(options).clock_high_water_ms).toBe(nowMs + 3_000);
  });
});

describe('local authority-state mutation', () => {
  function fakeDependencies(audit: { append: () => void }): AuthorityStateCommandDependencies {
    return {
      acquireOwnership: async () => ({ close: async () => undefined }),
      openRuntime: (() => ({
        audit,
        close: () => undefined,
      })) as unknown as (context: CommandContext) => Phase4ManagementRuntime,
      clock: () => nowMs,
      randomBytes: () => Buffer.alloc(AUTHORIZATION_EPOCH_BYTES, 4),
    };
  }

  it('initializes only through an explicit command and records no raw epoch', async () => {
    const context = stateContext();
    const audit = { append: vi.fn() };
    const result = await runAuthorityStateCommand(context, { action: 'init' }, fakeDependencies(audit));

    expect(result.readiness).toBe('READY');
    expect(result.auditRecorded).toBe(true);
    expect(result.epochFingerprint).not.toBe('04'.repeat(32));
    expect(audit.append).toHaveBeenCalledOnce();
  });

  it('refuses init overwrite and permits explicit clock-recovery rotation', async () => {
    const context = stateContext();
    writeInitial(2);
    const audit = { append: vi.fn() };

    await expect(runAuthorityStateCommand(context, { action: 'init' }, fakeDependencies(audit)))
      .rejects.toThrow('refused to overwrite');

    nowMs += 10_000;
    const rotated = await runAuthorityStateCommand(
      context,
      { action: 'rotate', reason: 'clock_recovery' },
      fakeDependencies(audit),
    );
    expect(rotated.readiness).toBe('READY');
    expect(rotated.reason).toBe('clock_recovery');
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('keeps the new state when audit fails after the state commit', async () => {
    const context = stateContext();
    writeInitial(3);
    const audit = { append: vi.fn(() => { throw new Error('audit unavailable'); }) };
    const result = await runAuthorityStateCommand(
      context,
      { action: 'rotate', reason: 'manual' },
      fakeDependencies(audit),
    );

    expect(result.readiness).toBe('READY');
    expect(result.auditRecorded).toBe(false);
    expect(result.warning).toContain('state committed');
    expect(readAuthorizationStateDocument(options).authorization_epoch).toBe('04'.repeat(32));
  });

  it('holds runtime ownership through the complete state mutation', async () => {
    const context = stateContext();
    const events: string[] = [];
    const audit = { append: vi.fn(() => events.push('audit')) };
    const fileSystem: AuthorizationStateFileSystem = {
      ...realFileSystem(),
      rename: (source, target) => {
        events.push('rename');
        renameSync(source, target);
      },
    };
    const dependencies: AuthorityStateCommandDependencies = {
      acquireOwnership: async () => {
        events.push('acquire');
        return { close: async () => { events.push('release'); } };
      },
      openRuntime: (() => {
        events.push('runtime');
        return { audit, close: () => undefined };
      }) as unknown as (context: CommandContext) => Phase4ManagementRuntime,
      clock: () => nowMs,
      randomBytes: () => Buffer.alloc(AUTHORIZATION_EPOCH_BYTES, 5),
      fileSystem,
    };

    await runAuthorityStateCommand(context, { action: 'init' }, dependencies);

    expect(events.indexOf('acquire')).toBe(0);
    expect(events.indexOf('release')).toBe(events.length - 1);
    expect(events.indexOf('rename')).toBeGreaterThan(events.indexOf('acquire'));
    expect(events.indexOf('rename')).toBeLessThan(events.indexOf('release'));
    expect(events.indexOf('audit')).toBeLessThan(events.indexOf('release'));
  });
});

function writeFileSyncForTest(path: string, value: string): void {
  writeFileSync(path, value, 'utf8');
  security.harden(path, 'file');
}
