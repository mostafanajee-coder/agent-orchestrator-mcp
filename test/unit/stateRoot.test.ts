import { posix as posixPath } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LEGACY_WINDOWS_SEGMENTS,
  POSIX_STATE_DIR,
  WINDOWS_STATE_DIR,
  isAbsoluteFor,
  legacyStateRoots,
  resolveStateRoot,
  stateDirectories,
  stateLayout,
} from '../../src/config/stateRoot.js';
import { SecurityError } from '../../src/errors.js';

/**
 * Expected Windows paths are written as literals, never built with the host's
 * `path.join`. Building them on the runner would reproduce the very bug these
 * tests exist to catch: on Linux, host `join` yields
 * `C:\Users\fixed/.agent-orchestrator-mcp`.
 */
const WINDOWS_PROFILE = 'C:\\Users\\fixed';
const WINDOWS_ROOT = 'C:\\Users\\fixed\\.agent-orchestrator-mcp';
const WINDOWS_LEGACY = 'C:\\Users\\fixed\\AppData\\Local\\AgentOrchestratorMCP';

const POSIX_PROFILE = '/home/fixed';

function win(
  env: Record<string, string> = {},
  profileDir = WINDOWS_PROFILE,
): { platform: 'win32'; env: Record<string, string>; profileDir: string } {
  return { platform: 'win32', env, profileDir };
}

/** Fails if a path mixes separators, e.g. `C:\Users\fixed/.agent-orchestrator-mcp`. */
function expectPureWindowsPath(value: string): void {
  expect(value).not.toContain('/');
}

describe('resolveStateRoot: Windows target', () => {
  it('builds a genuine Windows path on any host', () => {
    const root = resolveStateRoot(win());
    expect(root).toBe(WINDOWS_ROOT);
    expectPureWindowsPath(root);
  });

  it('uses the profile directory, not LOCALAPPDATA', () => {
    const root = resolveStateRoot(win({ LOCALAPPDATA: 'C:\\Users\\fixed\\AppData\\Local' }));
    expect(root).toBe(WINDOWS_ROOT);
    expect(root).not.toContain('AppData');
  });

  it('is unaffected by the value of LOCALAPPDATA', () => {
    expect(resolveStateRoot(win({ LOCALAPPDATA: 'D:\\elsewhere' }))).toBe(
      resolveStateRoot(win()),
    );
  });

  it('is unaffected by a packaged-style virtualized LOCALAPPDATA', () => {
    const root = resolveStateRoot(
      win({ LOCALAPPDATA: 'C:\\Users\\fixed\\AppData\\Local\\Packages\\Some.App_abc\\LocalCache\\Local' }),
    );
    expect(root).toBe(WINDOWS_ROOT);
    expect(root).not.toContain('Packages');
  });

  it('resolves without LOCALAPPDATA being set at all', () => {
    expect(resolveStateRoot(win({}))).toBe(WINDOWS_ROOT);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('fails closed on a %s profile directory', (_label, profileDir) => {
    expect(() => resolveStateRoot(win({}, profileDir))).toThrow(SecurityError);
  });

  it('fails closed on a relative profile directory', () => {
    expect(() => resolveStateRoot(win({}, 'Users\\fixed'))).toThrow(/not an absolute Windows path/);
  });

  it('fails closed on a POSIX profile directory when targeting Windows', () => {
    expect(() => resolveStateRoot(win({}, '/home/fixed'))).toThrow(/not an absolute Windows path/);
  });

  it.each([['C:\\'], ['C:/'], ['C:']])('rejects the drive root %s', (profileDir) => {
    expect(() => resolveStateRoot(win({}, profileDir))).toThrow(/filesystem root/);
  });

  it.each([['\\\\server\\profiles\\fixed'], ['\\\\server\\share']])(
    'rejects the UNC profile %s',
    (profileDir) => {
      // V1 is a local orchestrator: the system of record must not live on a share.
      expect(() => resolveStateRoot(win({}, profileDir))).toThrow(/network \(UNC\) path/);
    },
  );

  it.each([['\\\\?\\C:\\Users\\fixed'], ['\\\\.\\C:\\Users\\fixed']])(
    'rejects the device-namespace profile %s',
    (profileDir) => {
      expect(() => resolveStateRoot(win({}, profileDir))).toThrow(/device namespace/);
    },
  );
});

describe('resolveStateRoot: POSIX target', () => {
  it('uses XDG_STATE_HOME', () => {
    const root = resolveStateRoot({
      platform: 'linux',
      env: { XDG_STATE_HOME: '/home/fixed/.state' },
      profileDir: POSIX_PROFILE,
    });
    expect(root).toBe('/home/fixed/.state/agent-orchestrator-mcp');
    expect(root).not.toContain('\\');
  });

  it('falls back to ~/.local/state', () => {
    const root = resolveStateRoot({ platform: 'linux', env: {}, profileDir: POSIX_PROFILE });
    expect(root).toBe('/home/fixed/.local/state/agent-orchestrator-mcp');
    expect(root).not.toContain('\\');
    expect(root).toBe(posixPath.join(POSIX_PROFILE, '.local', 'state', POSIX_STATE_DIR));
  });

  it('ignores a relative XDG_STATE_HOME, as the XDG spec requires', () => {
    const root = resolveStateRoot({
      platform: 'linux',
      env: { XDG_STATE_HOME: 'relative/state' },
      profileDir: POSIX_PROFILE,
    });
    expect(root).toBe('/home/fixed/.local/state/agent-orchestrator-mcp');
  });

  it('rejects the filesystem root as a profile directory', () => {
    expect(() =>
      resolveStateRoot({ platform: 'linux', env: {}, profileDir: '/' }),
    ).toThrow(/filesystem root/);
  });
});

describe('isAbsoluteFor', () => {
  it('judges absoluteness for the given platform, not the running one', () => {
    expect(isAbsoluteFor('C:\\Users\\fixed', 'win32')).toBe(true);
    expect(isAbsoluteFor('C:/Users/fixed', 'win32')).toBe(true);
    expect(isAbsoluteFor('\\\\server\\share', 'win32')).toBe(true);
    expect(isAbsoluteFor('Users\\fixed', 'win32')).toBe(false);
    expect(isAbsoluteFor('/home/fixed', 'linux')).toBe(true);
    expect(isAbsoluteFor('home/fixed', 'linux')).toBe(false);
  });
});

describe('resolveStateRoot: no override', () => {
  it('does not vary with any caller-supplied environment variable', () => {
    const poisoned = resolveStateRoot(
      win({
        AGENT_ORCHESTRATOR_STATE_ROOT: 'C:\\attacker',
        STATE_ROOT: 'C:\\attacker',
        LOCALAPPDATA: 'C:\\attacker',
        USERPROFILE: 'C:\\attacker',
        HOME: '/attacker',
        HOMEDRIVE: 'D:',
        HOMEPATH: '\\attacker',
      }),
    );
    expect(poisoned).toBe(WINDOWS_ROOT);
  });
});

describe('legacyStateRoots', () => {
  it('derives the legacy root from the trusted profile, as a genuine Windows path', () => {
    expect(legacyStateRoots(win())).toEqual([WINDOWS_LEGACY]);
    expectPureWindowsPath(WINDOWS_LEGACY);
    expect(LEGACY_WINDOWS_SEGMENTS).toEqual(['AppData', 'Local', 'AgentOrchestratorMCP']);
  });

  it.each([
    ['a UNC share', '\\\\attacker-server\\share'],
    ['a device path', '\\\\?\\D:\\attacker'],
    ['another drive', 'D:\\attacker-local'],
    ['a relative path', 'attacker'],
    ['an empty value', ''],
  ])('ignores LOCALAPPDATA set to %s', (_label, localAppData) => {
    // The legacy path is advisory. It must never become an attacker-chosen
    // location that doctor would then probe with existsSync.
    expect(legacyStateRoots(win({ LOCALAPPDATA: localAppData }))).toEqual([WINDOWS_LEGACY]);
  });

  it('is never the active root', () => {
    const environment = win();
    expect(legacyStateRoots(environment)).not.toContain(resolveStateRoot(environment));
  });

  it('reports nothing when the profile itself is unusable', () => {
    expect(legacyStateRoots(win({}, ''))).toEqual([]);
    expect(legacyStateRoots(win({}, '\\\\server\\share'))).toEqual([]);
  });

  it('reports nothing on POSIX', () => {
    expect(
      legacyStateRoots({ platform: 'linux', env: { LOCALAPPDATA: '/x' }, profileDir: POSIX_PROFILE }),
    ).toEqual([]);
  });
});

describe('stateLayout: target-platform separators', () => {
  it('builds Windows child paths with backslashes on any host', () => {
    const layout = stateLayout(WINDOWS_ROOT, 'win32');

    expect(layout.root).toBe(WINDOWS_ROOT);
    expect(layout.data).toBe('C:\\Users\\fixed\\.agent-orchestrator-mcp\\data');
    expect(layout.artifacts).toBe('C:\\Users\\fixed\\.agent-orchestrator-mcp\\artifacts');
    expect(layout.secrets).toBe('C:\\Users\\fixed\\.agent-orchestrator-mcp\\secrets');
    expect(layout.logs).toBe('C:\\Users\\fixed\\.agent-orchestrator-mcp\\logs');
    expect(layout.leaseKey).toBe('C:\\Users\\fixed\\.agent-orchestrator-mcp\\secrets\\lease.key');

    for (const value of Object.values(layout)) expectPureWindowsPath(value);
  });

  it('builds POSIX child paths with forward slashes on any host', () => {
    const layout = stateLayout('/home/fixed/.local/state/agent-orchestrator-mcp', 'linux');

    expect(layout.secrets).toBe('/home/fixed/.local/state/agent-orchestrator-mcp/secrets');
    expect(layout.leaseKey).toBe(
      '/home/fixed/.local/state/agent-orchestrator-mcp/secrets/lease.key',
    );
    for (const value of Object.values(layout)) expect(value).not.toContain('\\');
  });

  it('orders secrets immediately after the root so it is hardened before the key is written', () => {
    const layout = stateLayout(WINDOWS_ROOT, 'win32');
    const directories = stateDirectories(layout);
    expect(directories[0]).toBe(layout.root);
    expect(directories[1]).toBe(layout.secrets);
    expect(directories).toHaveLength(5);
  });
});

describe('end-to-end Windows model on any host', () => {
  it('produces the full canonical path set', () => {
    const environment = win();
    const root = resolveStateRoot(environment);
    const layout = stateLayout(root, 'win32');

    expect(root).toBe('C:\\Users\\fixed\\.agent-orchestrator-mcp');
    expect(layout.secrets).toBe('C:\\Users\\fixed\\.agent-orchestrator-mcp\\secrets');
    expect(layout.leaseKey).toBe('C:\\Users\\fixed\\.agent-orchestrator-mcp\\secrets\\lease.key');
    expect(legacyStateRoots(environment)[0]).toBe(
      'C:\\Users\\fixed\\AppData\\Local\\AgentOrchestratorMCP',
    );
    expect(WINDOWS_STATE_DIR).toBe('.agent-orchestrator-mcp');
  });
});
