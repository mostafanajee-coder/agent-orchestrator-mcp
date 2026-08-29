import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecurityError } from '../../src/errors.js';
import { expectedToolPaths, resolveSystemTools } from '../../src/security/systemTools.js';
import { createSecurityProvider } from '../../src/security/factory.js';
import { nodeCommandRunner } from '../../src/security/exec.js';

let workspace: string;

/** Builds a fake SystemRoot containing real files where the tools must live. */
function makeSystemRoot(options: { icacls?: boolean; powershell?: boolean } = {}): string {
  const root = join(workspace, 'Windows');
  const paths = expectedToolPaths(root);
  mkdirSync(join(root, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true });
  if (options.icacls !== false) writeFileSync(paths.icacls, 'MZ');
  if (options.powershell !== false) writeFileSync(paths.powershell, 'MZ');
  return root;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'aomcp-tools-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('expectedToolPaths', () => {
  it('places both tools under System32', () => {
    const paths = expectedToolPaths('C:/Windows');
    expect(paths.icacls).toBe(join('C:/Windows', 'System32', 'icacls.exe'));
    expect(paths.powershell).toBe(
      join('C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
  });
});

describe('resolveSystemTools: fail closed', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('refuses a %s SystemRoot', (_label, value) => {
    expect(() => resolveSystemTools(value)).toThrow(SecurityError);
  });

  it.each([
    ['relative', 'Windows'],
    ['relative with separator', 'some/Windows'],
  ])('refuses a %s SystemRoot on any platform', (_label, value) => {
    expect(() => resolveSystemTools(value, 'win32')).toThrow(/not an absolute path/);
    expect(() => resolveSystemTools(value, 'linux')).toThrow(/not an absolute path/);
  });

  it('refuses a POSIX SystemRoot when running on Windows', () => {
    // Provable from a Linux CI machine because the platform is injected
    // rather than read from a global.
    expect(() => resolveSystemTools('/usr/lib', 'win32')).toThrow(/not an absolute Windows path/);
  });

  it('does not demand a drive letter off Windows', () => {
    // The drive-letter rule is Windows-specific. Off Windows an absolute path
    // is accepted and validation proceeds to the executable checks, which is
    // what lets these tests run on a Linux runner at all.
    expect(() => resolveSystemTools('/usr/lib', 'linux')).toThrow(/was not found/);
  });

  it('fails closed when icacls is missing', () => {
    const root = makeSystemRoot({ icacls: false });
    expect(() => resolveSystemTools(root)).toThrow(/icacls\.exe was not found/);
  });

  it('fails closed when powershell is missing', () => {
    const root = makeSystemRoot({ powershell: false });
    expect(() => resolveSystemTools(root)).toThrow(/powershell\.exe was not found/);
  });

  it('fails closed when a tool is a link rather than a real executable', () => {
    const root = makeSystemRoot({ icacls: false });
    const decoy = join(workspace, 'decoy.exe');
    writeFileSync(decoy, 'MZ');
    try {
      symlinkSync(decoy, expectedToolPaths(root).icacls);
    } catch {
      return; // symlink creation not permitted here; covered on other platforms
    }
    expect(() => resolveSystemTools(root)).toThrow(/is a link, not a regular executable/);
  });

  it('fails closed when a tool path is a directory', () => {
    const root = makeSystemRoot({ icacls: false });
    mkdirSync(expectedToolPaths(root).icacls, { recursive: true });
    expect(() => resolveSystemTools(root)).toThrow(/not a regular file/);
  });
});

describe('resolveSystemTools: PATH is never consulted', () => {
  it('ignores a PATH entry supplying a matching executable', () => {
    // A directory that would win a PATH lookup for both tools.
    const attacker = join(workspace, 'attacker');
    mkdirSync(attacker, { recursive: true });
    writeFileSync(join(attacker, 'icacls.exe'), 'MZ');
    writeFileSync(join(attacker, 'powershell.exe'), 'MZ');

    const originalPath = process.env['PATH'];
    process.env['PATH'] = attacker;
    try {
      // No SystemRoot: resolution must fail rather than fall back to PATH.
      expect(() => resolveSystemTools(undefined)).toThrow(SecurityError);

      // With a valid SystemRoot, the resolved paths are the trusted ones and
      // never the attacker copies.
      const tools = resolveSystemTools(makeSystemRoot());
      expect(tools.icacls).not.toContain('attacker');
      expect(tools.powershell).not.toContain('attacker');
      expect(tools.icacls).toBe(expectedToolPaths(makeSystemRoot()).icacls);
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
    }
  });
});

describe('resolveSystemTools: success', () => {
  it('returns the absolute trusted paths', () => {
    const root = makeSystemRoot();
    expect(resolveSystemTools(root)).toEqual(expectedToolPaths(root));
  });

  it('resolves a simulated SystemRoot under a POSIX temp directory', () => {
    // Exercises the exact path a Linux CI runner takes: an absolute POSIX
    // SystemRoot with real files standing in for the tools. Runs on every
    // platform, so the Linux behaviour is provable from Windows.
    const root = makeSystemRoot();
    expect(resolveSystemTools(root, 'linux')).toEqual(expectedToolPaths(root));
  });

  // Separate tests: each needs a fresh workspace, since makeSystemRoot writes
  // into one directory and does not remove tools a previous call created.
  it('reaches the missing-icacls check off Windows', () => {
    expect(() => resolveSystemTools(makeSystemRoot({ icacls: false }), 'linux')).toThrow(
      /icacls\.exe was not found/,
    );
  });

  it('reaches the missing-powershell check off Windows', () => {
    expect(() => resolveSystemTools(makeSystemRoot({ powershell: false }), 'linux')).toThrow(
      /powershell\.exe was not found/,
    );
  });
});

describe('production wiring', () => {
  it('fails closed rather than using PATH when SystemRoot is absent', () => {
    // createSecurityProvider is the only production construction path and
    // never injects tool paths, so a missing SystemRoot must be fatal.
    const provider = createSecurityProvider({
      platform: 'win32',
      runner: nodeCommandRunner,
      systemRoot: undefined,
    });
    expect(() => provider.subject()).toThrow(SecurityError);
  });

  it('threads the platform through, so a Windows provider rejects a POSIX SystemRoot', () => {
    const provider = createSecurityProvider({
      platform: 'win32',
      runner: nodeCommandRunner,
      systemRoot: '/usr/lib',
    });
    expect(() => provider.subject()).toThrow(/not an absolute Windows path/);
  });
});
