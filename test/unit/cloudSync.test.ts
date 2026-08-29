import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import { assertStateRootNotSynced, detectSyncRoots, isInside } from '../../src/config/cloudSync.js';
import { SecurityError } from '../../src/errors.js';

function environment(
  env: Record<string, string>,
  files: Record<string, string> = {},
  platform: NodeJS.Platform = 'win32',
): CloudSyncEnvironment {
  return { platform, env, readFileIfPresent: (path) => files[path] };
}

/** Models a filesystem where some paths resolve elsewhere, as a link would. */
function environmentWithRealPaths(
  env: Record<string, string>,
  realPaths: Record<string, string>,
  platform: NodeJS.Platform = 'win32',
): CloudSyncEnvironment {
  return {
    platform,
    env,
    readFileIfPresent: () => undefined,
    realPathIfPresent: (path) => realPaths[path],
  };
}

describe('detectSyncRoots', () => {
  it('reads the real OneDrive path from the environment rather than a folder name', () => {
    const roots = detectSyncRoots(
      environment({ OneDrive: 'D:/Sync/Wolke', OneDriveCommercial: 'D:/Sync/Firma' }),
    );
    expect(roots.map((root) => root.path)).toEqual(['D:/Sync/Wolke', 'D:/Sync/Firma']);
  });

  it('reads Dropbox roots from its own info.json', () => {
    const infoPath = join('C:/Users/example/AppData/Local', 'Dropbox', 'info.json');
    const roots = detectSyncRoots(
      environment(
        { LOCALAPPDATA: 'C:/Users/example/AppData/Local' },
        { [infoPath]: JSON.stringify({ personal: { path: 'C:/Users/example/Dropbox' } }) },
      ),
    );
    expect(roots).toEqual([{ path: 'C:/Users/example/Dropbox', provider: 'Dropbox (personal)' }]);
  });

  it('ignores malformed Dropbox configuration instead of failing', () => {
    const infoPath = join('C:/Users/example/AppData/Local', 'Dropbox', 'info.json');
    const roots = detectSyncRoots(
      environment({ LOCALAPPDATA: 'C:/Users/example/AppData/Local' }, { [infoPath]: 'not json' }),
    );
    expect(roots).toEqual([]);
  });

  it('returns nothing when no sync client is present', () => {
    expect(detectSyncRoots(environment({}))).toEqual([]);
  });
});

describe('isInside', () => {
  it('treats a path as inside itself', () => {
    expect(isInside('/a/b', '/a/b', false)).toBe(true);
  });

  it('detects containment', () => {
    expect(isInside('/a/b/c', '/a/b', false)).toBe(true);
  });

  it('rejects a sibling whose name shares a prefix', () => {
    expect(isInside('/a/bcd', '/a/b', false)).toBe(false);
  });

  it('compares case-insensitively for Windows', () => {
    expect(isInside('C:/Users/Example/OneDrive/state', 'C:/users/example/onedrive', true)).toBe(true);
  });
});

describe('assertStateRootNotSynced', () => {
  it('passes when the state root is outside every sync root', () => {
    expect(() =>
      assertStateRootNotSynced(
        'C:/Users/example/AppData/Local/AgentOrchestratorMCP',
        environment({ OneDrive: 'C:/Users/example/OneDrive' }),
      ),
    ).not.toThrow();
  });

  it('fails closed when the state root is inside a sync root, naming the provider', () => {
    expect(() =>
      assertStateRootNotSynced(
        'C:/Users/example/OneDrive/AppData/Local/AgentOrchestratorMCP',
        environment({ OneDrive: 'C:/Users/example/OneDrive' }),
      ),
    ).toThrow(SecurityError);

    try {
      assertStateRootNotSynced(
        'C:/Users/example/OneDrive/state',
        environment({ OneDrive: 'C:/Users/example/OneDrive' }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SecurityError);
      expect((error as SecurityError).message).toContain('OneDrive');
      expect((error as SecurityError).remedy).toBeDefined();
    }
  });
});

describe('assertStateRootNotSynced: real-path pass', () => {
  const ONEDRIVE = 'C:/Users/example/OneDrive';
  const ROOT = 'C:/Users/example/AppData/Local/AgentOrchestratorMCP';

  it('passes when neither the name nor the resolved path is synchronised', () => {
    expect(() =>
      assertStateRootNotSynced(
        ROOT,
        environmentWithRealPaths({ OneDrive: ONEDRIVE }, { [ROOT]: ROOT, [ONEDRIVE]: ONEDRIVE }),
      ),
    ).not.toThrow();
  });

  it('rejects a state root whose name looks safe but resolves into a sync root', () => {
    // The classic junction bypass: the literal path is outside OneDrive, but
    // the directory is a redirection into it.
    const environment = environmentWithRealPaths(
      { OneDrive: ONEDRIVE },
      { [ROOT]: `${ONEDRIVE}/redirected/AgentOrchestratorMCP`, [ONEDRIVE]: ONEDRIVE },
    );
    expect(() => assertStateRootNotSynced(ROOT, environment)).toThrow(SecurityError);
    expect(() => assertStateRootNotSynced(ROOT, environment)).toThrow(/resolves inside/);
  });

  it('rejects when the sync root itself is a link containing the resolved state root', () => {
    const environment = environmentWithRealPaths(
      { OneDrive: ONEDRIVE },
      { [ROOT]: 'D:/Synced/state', [ONEDRIVE]: 'D:/Synced' },
    );
    expect(() => assertStateRootNotSynced(ROOT, environment)).toThrow(/resolves inside/);
  });

  it('compares resolved paths case-insensitively on Windows', () => {
    const environment = environmentWithRealPaths(
      { OneDrive: ONEDRIVE },
      { [ROOT]: 'D:/SYNCED/State', [ONEDRIVE]: 'd:/synced' },
    );
    expect(() => assertStateRootNotSynced(ROOT, environment)).toThrow(SecurityError);
  });

  it('falls back to the lexical check when the state root does not exist yet', () => {
    // Before init, realPathIfPresent returns undefined; the lexical check must
    // still refuse an obviously synchronised location.
    const environment = environmentWithRealPaths({ OneDrive: ONEDRIVE }, {});
    expect(() => assertStateRootNotSynced(`${ONEDRIVE}/state`, environment)).toThrow(SecurityError);
    expect(() => assertStateRootNotSynced(ROOT, environment)).not.toThrow();
  });

  it('still works when no real-path resolver is supplied at all', () => {
    expect(() =>
      assertStateRootNotSynced(`${ONEDRIVE}/state`, environment({ OneDrive: ONEDRIVE })),
    ).toThrow(SecurityError);
  });
});
