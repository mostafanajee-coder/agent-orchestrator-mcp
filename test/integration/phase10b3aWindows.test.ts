import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_EPOCH_BYTES,
  createAuthorizationStateDocument,
  writeAuthorizationState,
  type AuthorizationStateFileSystem,
} from '../../src/authority/authorizationState.js';
import { stateLayout } from '../../src/config/stateRoot.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';

const onWindows = process.platform === 'win32';

let workspace: string;
let root: string;
let target: string;
let security: FakeSecurityProvider;
let unlinkCalls: string[];

function realFileSystem(): AuthorizationStateFileSystem {
  return {
    exists: existsSync,
    lstat: (path) => {
      const stats = lstatSync(path);
      return { size: stats.size, nlink: stats.nlink };
    },
    read: (path) => readFileSync(path, 'utf8'),
    open: (path, flags, mode) => mode === undefined ? openSync(path, flags) : openSync(path, flags, mode),
    write: writeSync,
    fsync: fsyncSync,
    close: closeSync,
    rename: renameSync,
    unlink: (path) => {
      unlinkCalls.push(path);
      unlinkSync(path);
    },
  };
}

describe.skipIf(!onWindows)('Phase 10B.3A real Windows replacement', () => {
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'aomcp-windows-replace-'));
    root = join(workspace, 'state');
    mkdirSync(root);
    security = new FakeSecurityProvider();
    security.harden(root, 'directory');
    target = stateLayout(root, 'win32').authorizationStateFile;
    unlinkCalls = [];
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('replaces an existing state file using the real same-directory rename primitive', () => {
    const fileSystem = realFileSystem();
    const oldDocument = createAuthorizationStateDocument(
      Date.parse('2026-09-03T10:00:00.000Z'),
      () => Buffer.alloc(AUTHORIZATION_EPOCH_BYTES, 0x11),
    );
    writeAuthorizationState({
      path: target,
      security,
      platform: 'win32',
      fileSystem,
      replace: false,
    }, oldDocument);
    const oldContent = readFileSync(target, 'utf8');

    const newDocument = createAuthorizationStateDocument(
      Date.parse('2026-09-03T10:00:01.000Z'),
      () => Buffer.alloc(AUTHORIZATION_EPOCH_BYTES, 0x22),
    );
    writeAuthorizationState({
      path: target,
      security,
      platform: 'win32',
      fileSystem,
      replace: true,
    }, newDocument);

    expect(existsSync(target)).toBe(true);
    const active = readFileSync(target, 'utf8');
    expect(active).not.toBe(oldContent);
    expect(JSON.parse(active)).toEqual({
      version: 1,
      authorization_epoch: '22'.repeat(32),
      clock_high_water_ms: Date.parse('2026-09-03T10:00:01.000Z'),
    });
    expect(readdirSync(root).filter((name) => name.startsWith('authorization-state.v1.json.tmp-'))).toEqual([]);
    expect(unlinkCalls).not.toContain(target);
  });
});
