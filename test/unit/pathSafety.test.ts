import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecurityError } from '../../src/errors.js';
import { assertPathIsSafe, canonicalise, inspectPathSafety } from '../../src/security/pathSafety.js';

const onWindows = process.platform === 'win32';

let workspace: string;
let realDir: string;
let realFile: string;

/** Creates a link, returning false when the platform refuses to make one. */
function tryLink(target: string, path: string, type: 'dir' | 'file'): boolean {
  try {
    symlinkSync(target, path, onWindows ? (type === 'dir' ? 'dir' : 'file') : undefined);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'aomcp-path-'));
  realDir = join(workspace, 'real');
  realFile = join(realDir, 'lease.key');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(realFile, Buffer.alloc(32));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('canonicalise', () => {
  it('is case-insensitive and separator-tolerant on Windows', () => {
    expect(canonicalise('C:/State/Root/', 'win32')).toBe(canonicalise('c:/state/root', 'win32'));
  });

  it('is exact on POSIX', () => {
    expect(canonicalise('/State', 'linux')).not.toBe(canonicalise('/state', 'linux'));
  });
});

describe('assertPathIsSafe: accepts real objects', () => {
  it('accepts a real directory', () => {
    expect(() => assertPathIsSafe(realDir, 'directory')).not.toThrow();
  });

  it('accepts a real file', () => {
    expect(() => assertPathIsSafe(realFile, 'file')).not.toThrow();
  });

  it('accepts a single-linked secret', () => {
    expect(() => assertPathIsSafe(realFile, 'file', process.platform, { requireSingleLink: true })).not.toThrow();
  });
});

describe('assertPathIsSafe: rejects redirection', () => {
  it('rejects a symbolic link to a directory', () => {
    const link = join(workspace, 'linkdir');
    if (!tryLink(realDir, link, 'dir')) return;
    expect(() => assertPathIsSafe(link, 'directory')).toThrow(SecurityError);
    expect(() => assertPathIsSafe(link, 'directory')).toThrow(/link or junction/);
  });

  it('rejects a symbolic link to a file', () => {
    const link = join(workspace, 'linkfile');
    if (!tryLink(realFile, link, 'file')) return;
    expect(() => assertPathIsSafe(link, 'file')).toThrow(SecurityError);
  });

  it.skipIf(!onWindows)('rejects an NTFS junction', () => {
    const junction = join(workspace, 'junc');
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', junction, realDir], { stdio: 'ignore' });
    } catch {
      return;
    }
    expect(() => assertPathIsSafe(junction, 'directory')).toThrow(SecurityError);
    expect(() => assertPathIsSafe(junction, 'directory')).toThrow(/link or junction/);
  });

  it('rejects a hard-linked secret, which is a second name for the same bytes', () => {
    const second = join(realDir, 'copy.key');
    try {
      linkSync(realFile, second);
    } catch {
      return;
    }
    expect(() =>
      assertPathIsSafe(realFile, 'file', process.platform, { requireSingleLink: true }),
    ).toThrow(/hard links/);
    // Without the option the link count is not policed.
    expect(() => assertPathIsSafe(realFile, 'file')).not.toThrow();
  });
});

describe('assertPathIsSafe: rejects wrong shapes and missing paths', () => {
  it('rejects a file where a directory is expected', () => {
    expect(() => assertPathIsSafe(realFile, 'directory')).toThrow(/expected to be a directory/);
  });

  it('rejects a directory where a file is expected', () => {
    expect(() => assertPathIsSafe(realDir, 'file')).toThrow(/expected to be a regular file/);
  });

  it('rejects a missing path', () => {
    expect(() => assertPathIsSafe(join(workspace, 'nope'), 'directory')).toThrow(SecurityError);
  });
});

describe('inspectPathSafety', () => {
  it('reports success without throwing', () => {
    expect(inspectPathSafety(realDir, 'directory')).toEqual({ safe: true, problem: undefined });
  });

  it('reports the problem instead of throwing', () => {
    const result = inspectPathSafety(join(workspace, 'nope'), 'directory');
    expect(result.safe).toBe(false);
    expect(result.problem).toBeDefined();
  });
});

describe('allowRedirectionBoundary', () => {
  it('still rejects a link even when the boundary is permitted', () => {
    // The exemption relaxes only the weaker realpath comparison. A hostile
    // junction or symlink is caught by lstat regardless, which is what makes
    // the exemption safe for the state root.
    const link = join(workspace, 'linkdir2');
    if (!tryLink(realDir, link, 'dir')) return;
    expect(() =>
      assertPathIsSafe(link, 'directory', process.platform, { allowRedirectionBoundary: true }),
    ).toThrow(/link or junction/);
  });

  it('still rejects the wrong object type', () => {
    expect(() =>
      assertPathIsSafe(realFile, 'directory', process.platform, { allowRedirectionBoundary: true }),
    ).toThrow(/expected to be a directory/);
  });

  it('still rejects a missing path', () => {
    expect(() =>
      assertPathIsSafe(join(workspace, 'nope'), 'directory', process.platform, {
        allowRedirectionBoundary: true,
      }),
    ).toThrow(SecurityError);
  });

  it('accepts a real directory', () => {
    expect(() =>
      assertPathIsSafe(realDir, 'directory', process.platform, { allowRedirectionBoundary: true }),
    ).not.toThrow();
  });
});
