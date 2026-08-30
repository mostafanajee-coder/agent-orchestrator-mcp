import { homedir, userInfo } from 'node:os';
import { join, win32 as winPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommandContext } from '../../src/commands/context.js';
import { WINDOWS_STATE_DIR, resolveStateRoot } from '../../src/config/stateRoot.js';

const onWindows = process.platform === 'win32';

/** Restores a process.env key to exactly what it was, including absence. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const originalEnv = new Map<string, string | undefined>();

function poison(key: string, value: string): void {
  if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of originalEnv) setEnv(key, value);
  originalEnv.clear();
});

/**
 * These exercise the production composition boundary, not the pure resolver.
 *
 * The resolver ignoring `env.USERPROFILE` proves nothing on its own if the
 * caller feeds it a value derived from USERPROFILE — which is exactly what
 * `os.homedir()` does on Windows.
 */
describe.skipIf(!onWindows)('createCommandContext: Windows profile trust boundary', () => {
  it('does not move the state root when USERPROFILE is poisoned', () => {
    const before = createCommandContext().layout.root;

    poison('USERPROFILE', 'D:\\attacker-profile');
    const after = createCommandContext().layout.root;

    expect(after).toBe(before);
    expect(after).not.toContain('attacker');
  });

  it('does not move the state root when LOCALAPPDATA is poisoned', () => {
    const before = createCommandContext().layout.root;

    poison('LOCALAPPDATA', 'D:\\attacker-local');
    expect(createCommandContext().layout.root).toBe(before);
  });

  it.each(['AGENT_ORCHESTRATOR_STATE_ROOT', 'STATE_ROOT', 'HOME', 'HOMEPATH', 'HOMEDRIVE'])(
    'does not move the state root when %s is poisoned',
    (key) => {
      const before = createCommandContext().layout.root;
      poison(key, 'D:\\attacker');
      expect(createCommandContext().layout.root).toBe(before);
    },
  );

  it('derives the root from OS identity, not from os.homedir()', () => {
    poison('USERPROFILE', 'D:\\attacker-profile');

    // os.homedir() follows USERPROFILE on Windows; os.userInfo().homedir does
    // not. The active root must track the latter.
    expect(homedir()).toBe('D:\\attacker-profile');
    expect(userInfo().homedir).not.toBe('D:\\attacker-profile');

    expect(createCommandContext().layout.root).toBe(
      join(userInfo().homedir, WINDOWS_STATE_DIR),
    );
  });

  it('never makes a legacy root authoritative', () => {
    const context = createCommandContext();
    for (const legacy of context.legacyRoots) {
      expect(legacy).not.toBe(context.layout.root);
    }
  });

  it.each([
    ['a UNC share', '\\\\attacker-server\\share'],
    ['a device path', '\\\\?\\D:\\attacker'],
    ['another drive', 'D:\\attacker-local'],
    ['a relative path', 'attacker'],
  ])('does not let LOCALAPPDATA set to %s steer the legacy probe', (_label, value) => {
    // doctor calls existsSync on whatever legacyRoots returns, so an
    // env-controlled value here would become an attacker-chosen path -- and a
    // UNC one would put a network probe in a read-only health check.
    const before = createCommandContext().legacyRoots;

    poison('LOCALAPPDATA', value);
    const after = createCommandContext().legacyRoots;

    expect(after).toEqual(before);
    for (const legacy of after) {
      expect(legacy).not.toContain('attacker');
      expect(legacy.startsWith('\\\\')).toBe(false);
      expect(legacy.startsWith(userInfo().homedir)).toBe(true);
    }
  });

  it('derives the legacy root from the profile directory', () => {
    const context = createCommandContext();
    expect(context.legacyRoots).toEqual([
      winPath.join(userInfo().homedir, 'AppData', 'Local', 'AgentOrchestratorMCP'),
    ]);
  });
});

describe('resolveStateRoot ignores every environment variable', () => {
  it('returns the same root whatever the environment says', () => {
    const profileDir = onWindows ? 'C:\\Users\\fixed' : '/home/fixed';
    const platform = onWindows ? ('win32' as const) : ('linux' as const);

    const clean = resolveStateRoot({ platform, env: {}, profileDir });
    const poisoned = resolveStateRoot({
      platform,
      env: {
        USERPROFILE: 'D:\\attacker',
        LOCALAPPDATA: 'D:\\attacker',
        AGENT_ORCHESTRATOR_STATE_ROOT: 'D:\\attacker',
        STATE_ROOT: 'D:\\attacker',
        HOME: '/attacker',
        HOMEDRIVE: 'D:',
        HOMEPATH: '\\attacker',
      },
      profileDir,
    });

    expect(poisoned).toBe(clean);
  });
});
