import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  POSIX_DIRECTORY_MODE,
  POSIX_FILE_MODE,
  PosixSecurityProvider,
  expectedMode,
} from '../../src/security/acl.posix.js';

const onPosix = process.platform !== 'win32';

describe('expectedMode', () => {
  it('requires owner-only permissions', () => {
    expect(expectedMode('directory')).toBe(0o700);
    expect(expectedMode('file')).toBe(0o600);
    expect(POSIX_DIRECTORY_MODE).toBe(0o700);
    expect(POSIX_FILE_MODE).toBe(0o600);
  });
});

// Windows ignores POSIX permission bits, so these assertions only mean
// something on a POSIX filesystem.
describe.skipIf(!onPosix)('PosixSecurityProvider', () => {
  let directory: string;
  let filePath: string;
  let provider: PosixSecurityProvider;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aomcp-posix-'));
    filePath = join(directory, 'lease.key');
    writeFileSync(filePath, 'x');
    provider = new PosixSecurityProvider();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('hardens a directory to 0700', () => {
    chmodSync(directory, 0o755);
    provider.harden(directory, 'directory');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(provider.verify(directory, 'directory').secure).toBe(true);
  });

  it('hardens a secret file to 0600', () => {
    chmodSync(filePath, 0o644);
    provider.harden(filePath, 'file');
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(provider.verify(filePath, 'file').secure).toBe(true);
  });

  it('rejects a group-readable secret', () => {
    chmodSync(filePath, 0o640);
    const report = provider.verify(filePath, 'file');
    expect(report.secure).toBe(false);
    expect(report.problems.join(' ')).toContain('0640');
  });

  it('rejects a world-readable secret', () => {
    chmodSync(filePath, 0o666);
    expect(provider.verify(filePath, 'file').secure).toBe(false);
  });

  it('rejects a world-traversable directory', () => {
    const nested = join(directory, 'nested');
    mkdirSync(nested, { mode: 0o777 });
    chmodSync(nested, 0o777);
    expect(provider.verify(nested, 'directory').secure).toBe(false);
  });

  it('reports the mode without exposing file contents', () => {
    provider.harden(filePath, 'file');
    const report = provider.verify(filePath, 'file');
    expect(report.detail).toContain('0600');
    expect(report.detail).not.toContain('x');
  });

  it('names the current user as the subject', () => {
    expect(provider.subject()).toMatch(/^uid \d+$/);
  });
});
