import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  POSIX_STATE_DIR,
  WINDOWS_STATE_DIR,
  resolveStateRoot,
  stateDirectories,
  stateLayout,
} from '../../src/config/stateRoot.js';
import { SecurityError } from '../../src/errors.js';

describe('resolveStateRoot', () => {
  it('uses LOCALAPPDATA on Windows', () => {
    const root = resolveStateRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:/Users/example/AppData/Local' },
      homedir: 'C:/Users/example',
    });
    expect(root).toBe(join('C:/Users/example/AppData/Local', WINDOWS_STATE_DIR));
  });

  it('fails closed on Windows when LOCALAPPDATA is missing', () => {
    expect(() =>
      resolveStateRoot({ platform: 'win32', env: {}, homedir: 'C:/Users/example' }),
    ).toThrow(SecurityError);
  });

  it('uses XDG_STATE_HOME on POSIX', () => {
    const root = resolveStateRoot({
      platform: 'linux',
      env: { XDG_STATE_HOME: '/home/example/.state' },
      homedir: '/home/example',
    });
    expect(root).toBe(join('/home/example/.state', POSIX_STATE_DIR));
  });

  it('falls back to ~/.local/state on POSIX when XDG_STATE_HOME is unset', () => {
    const root = resolveStateRoot({ platform: 'linux', env: {}, homedir: '/home/example' });
    expect(root).toBe(join('/home/example', '.local', 'state', POSIX_STATE_DIR));
  });

  it('ignores a relative XDG_STATE_HOME, as the XDG spec requires', () => {
    const root = resolveStateRoot({
      platform: 'linux',
      env: { XDG_STATE_HOME: 'relative/state' },
      homedir: '/home/example',
    });
    expect(root).toBe(join('/home/example', '.local', 'state', POSIX_STATE_DIR));
  });

  it('ignores an empty XDG_STATE_HOME', () => {
    const root = resolveStateRoot({
      platform: 'darwin',
      env: { XDG_STATE_HOME: '   ' },
      homedir: '/Users/example',
    });
    expect(root).toBe(join('/Users/example', '.local', 'state', POSIX_STATE_DIR));
  });

  it('does not vary with any caller-supplied override variable', () => {
    const base = { platform: 'linux' as const, homedir: '/home/example' };
    const withOverrides = resolveStateRoot({
      ...base,
      env: {
        AGENT_ORCHESTRATOR_STATE_ROOT: '/tmp/attacker',
        STATE_ROOT: '/tmp/attacker',
      },
    });
    expect(withOverrides).toBe(resolveStateRoot({ ...base, env: {} }));
  });
});

describe('stateLayout', () => {
  const layout = stateLayout('/state');

  it('places every directory under the single root', () => {
    expect(layout).toEqual({
      root: '/state',
      data: join('/state', 'data'),
      artifacts: join('/state', 'artifacts'),
      secrets: join('/state', 'secrets'),
      logs: join('/state', 'logs'),
      leaseKey: join('/state', 'secrets', 'lease.key'),
    });
  });

  it('orders secrets immediately after the root so it is hardened before the key is written', () => {
    const directories = stateDirectories(layout);
    expect(directories[0]).toBe(layout.root);
    expect(directories[1]).toBe(layout.secrets);
    expect(directories).toHaveLength(5);
  });
});
