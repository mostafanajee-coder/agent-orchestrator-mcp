import { describe, expect, it } from 'vitest';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import {
  assertStateRootNotSynced,
  detectSyncRoots,
  isInside,
  isUsableSyncCandidate,
} from '../../src/config/cloudSync.js';
import { stateLayout } from '../../src/config/stateRoot.js';
import { SecurityError } from '../../src/errors.js';

const WIN_PROFILE = 'C:\\Users\\example';
const ATTACKER_UNC = '\\\\attacker-server\\share';

/** Records every path that reaches the filesystem, so probes can be asserted on. */
interface Spy {
  readonly reads: string[];
  readonly realpaths: string[];
}

function spyEnvironment(
  env: Record<string, string>,
  options: {
    files?: Record<string, string>;
    realPaths?: Record<string, string>;
    platform?: NodeJS.Platform;
    profileDir?: string;
    withRealPath?: boolean;
  } = {},
): { environment: CloudSyncEnvironment; spy: Spy } {
  const spy: Spy = { reads: [], realpaths: [] };
  const files = options.files ?? {};
  const realPaths = options.realPaths ?? {};

  const environment: CloudSyncEnvironment = {
    platform: options.platform ?? 'win32',
    env,
    profileDir: options.profileDir ?? WIN_PROFILE,
    readFileIfPresent: (path) => {
      spy.reads.push(path);
      return files[path];
    },
    ...(options.withRealPath === false
      ? {}
      : {
          realPathIfPresent: (path: string): string | undefined => {
            spy.realpaths.push(path);
            return realPaths[path];
          },
        }),
  };

  return { environment, spy };
}

function environment(
  env: Record<string, string>,
  files: Record<string, string> = {},
  platform: NodeJS.Platform = 'win32',
): CloudSyncEnvironment {
  return spyEnvironment(env, { files, platform, withRealPath: false }).environment;
}

/** The Dropbox config paths production would build, captured from the spy. */
function dropboxProbePaths(profileDir = WIN_PROFILE): string[] {
  const { environment: env, spy } = spyEnvironment({}, { profileDir });
  detectSyncRoots(env);
  return spy.reads;
}

/** The first (Local) Dropbox config path production would build. */
function dropboxProbePath(profileDir = WIN_PROFILE): string {
  return dropboxProbePaths(profileDir)[0] ?? '';
}

describe('isUsableSyncCandidate', () => {
  it.each([['C:\\Users\\kingm\\OneDrive'], ['D:\\OneDrive'], ['C:/Users/kingm/OneDrive']])(
    'accepts the local candidate %s',
    (value) => {
      expect(isUsableSyncCandidate(value, 'win32')).toBe(true);
    },
  );

  it.each([
    ['a UNC share', '\\\\server\\share'],
    ['a device path', '\\\\?\\C:\\OneDrive'],
    ['a dot-device path', '\\\\.\\C:\\OneDrive'],
    ['a relative path', 'relative\\path'],
    ['a drive-relative path', 'C:relative'],
    ['a drive root', 'C:\\'],
    ['an empty value', ''],
  ])('rejects %s as a discovery candidate', (_label, value) => {
    expect(isUsableSyncCandidate(value, 'win32')).toBe(false);
  });

  it('keeps POSIX conventional', () => {
    expect(isUsableSyncCandidate('/home/example/OneDrive', 'linux')).toBe(true);
    expect(isUsableSyncCandidate('relative', 'linux')).toBe(false);
  });
});

describe('detectSyncRoots: environment candidates are validated before use', () => {
  it('accepts a legitimate local OneDrive root', () => {
    const roots = detectSyncRoots(environment({ OneDrive: 'D:\\OneDrive' }));
    expect(roots).toEqual([{ path: 'D:\\OneDrive', provider: 'OneDrive' }]);
  });

  it.each([
    ['OneDrive', ATTACKER_UNC],
    ['OneDriveCommercial', '\\\\?\\C:\\attacker'],
    ['OneDriveConsumer', 'relative-path'],
  ])('drops the unusable %s candidate without probing it', (variable, value) => {
    const { environment: env, spy } = spyEnvironment({ [variable]: value });

    expect(detectSyncRoots(env)).toEqual([]);
    expect(spy.reads).not.toContain(value);
    expect(spy.realpaths).not.toContain(value);
  });

  it('keeps a valid candidate while dropping an invalid sibling', () => {
    const roots = detectSyncRoots(
      environment({ OneDrive: ATTACKER_UNC, OneDriveCommercial: 'D:\\OneDrive' }),
    );
    expect(roots).toEqual([{ path: 'D:\\OneDrive', provider: 'OneDrive for Business' }]);
  });
});

describe('detectSyncRoots: Dropbox config comes from the trusted profile', () => {
  it('reads info.json from under the profile directory', () => {
    const probes = dropboxProbePaths();
    expect(probes).toHaveLength(2);
    expect(probes[0]).toBe(`${WIN_PROFILE}\\AppData\\Local\\Dropbox\\info.json`);
    expect(probes[1]).toBe(`${WIN_PROFILE}\\AppData\\Roaming\\Dropbox\\info.json`);
    for (const probe of probes) {
      expect(probe).toContain('Dropbox');
      expect(probe).toContain('info.json');
      expect(probe.startsWith(WIN_PROFILE)).toBe(true);
    }
  });

  it('parses a legitimate Local Dropbox root', () => {
    const [local] = dropboxProbePaths();
    const roots = detectSyncRoots(
      environment({}, { [local ?? '']: JSON.stringify({ personal: { path: 'D:\\Dropbox' } }) }),
    );
    expect(roots).toEqual([{ path: 'D:\\Dropbox', provider: 'Dropbox (personal)' }]);
  });

  it('parses a legitimate Roaming-only Dropbox root', () => {
    const [, roaming] = dropboxProbePaths();
    const roots = detectSyncRoots(
      environment({}, { [roaming ?? '']: JSON.stringify({ personal: { path: 'D:\\Dropbox' } }) }),
    );
    expect(roots).toEqual([{ path: 'D:\\Dropbox', provider: 'Dropbox (personal)' }]);
  });

  it('reads both metadata locations when both are present', () => {
    const [local, roaming] = dropboxProbePaths();
    const { environment: env, spy } = spyEnvironment({}, {
      files: {
        [local ?? '']: JSON.stringify({ personal: { path: 'D:\\Dropbox-Local' } }),
        [roaming ?? '']: JSON.stringify({ business: { path: 'E:\\Dropbox-Roaming' } }),
      },
    });

    expect(detectSyncRoots(env)).toEqual([
      { path: 'D:\\Dropbox-Local', provider: 'Dropbox (personal)' },
      { path: 'E:\\Dropbox-Roaming', provider: 'Dropbox (business)' },
    ]);
    expect(spy.reads).toEqual([local, roaming]);
  });

  it('deduplicates the same root described by both metadata locations', () => {
    const [local, roaming] = dropboxProbePaths();
    const roots = detectSyncRoots(
      environment({}, {
        [local ?? '']: JSON.stringify({ personal: { path: 'D:\\Dropbox' } }),
        [roaming ?? '']: JSON.stringify({ business: { path: 'd:/DROPBOX\\' } }),
      }),
    );

    expect(roots).toEqual([{ path: 'D:\\Dropbox', provider: 'Dropbox (personal)' }]);
  });

  it('keeps distinct valid roots from both metadata locations', () => {
    const [local, roaming] = dropboxProbePaths();
    const roots = detectSyncRoots(
      environment({}, {
        [local ?? '']: JSON.stringify({ personal: { path: 'D:\\Dropbox' } }),
        [roaming ?? '']: JSON.stringify({ business: { path: 'E:\\Dropbox' } }),
      }),
    );

    expect(roots).toEqual([
      { path: 'D:\\Dropbox', provider: 'Dropbox (personal)' },
      { path: 'E:\\Dropbox', provider: 'Dropbox (business)' },
    ]);
  });

  it('keeps a valid location when the other metadata file is malformed', () => {
    const [local, roaming] = dropboxProbePaths();
    const roots = detectSyncRoots(
      environment({}, {
        [local ?? '']: 'not json',
        [roaming ?? '']: JSON.stringify({ personal: { path: 'D:\\Dropbox' } }),
      }),
    );

    expect(roots).toEqual([{ path: 'D:\\Dropbox', provider: 'Dropbox (personal)' }]);
  });

  it.each([
    ['a UNC share', ATTACKER_UNC],
    ['a device path', '\\\\?\\D:\\attacker'],
    ['another drive', 'D:\\attacker-local'],
    ['a relative path', 'attacker'],
  ])('does not let LOCALAPPDATA set to %s change the path read', (_label, value) => {
    const { environment: env, spy } = spyEnvironment({ LOCALAPPDATA: value });
    detectSyncRoots(env);

    expect(spy.reads).toEqual(dropboxProbePaths());
    for (const read of spy.reads) {
      expect(read).not.toContain('attacker');
      expect(read.startsWith('\\\\')).toBe(false);
    }
  });

  it('ignores HOME as a config location', () => {
    const { environment: env, spy } = spyEnvironment({ HOME: ATTACKER_UNC });
    detectSyncRoots(env);
    expect(spy.reads).toEqual(dropboxProbePaths());
  });

  it('ignores hostile USERPROFILE, LOCALAPPDATA, and APPDATA values', () => {
    const { environment: env, spy } = spyEnvironment({
      USERPROFILE: ATTACKER_UNC,
      LOCALAPPDATA: '\\\\?\\C:\\attacker',
      APPDATA: 'relative-attacker',
    });

    detectSyncRoots(env);

    expect(spy.reads).toEqual(dropboxProbePaths());
    for (const read of spy.reads) {
      expect(read.startsWith(WIN_PROFILE)).toBe(true);
      expect(read).not.toContain('attacker');
      expect(read.startsWith('\\\\')).toBe(false);
    }
  });

  it('reads nothing when the profile itself is unusable', () => {
    const { environment: env, spy } = spyEnvironment({}, { profileDir: ATTACKER_UNC });
    expect(detectSyncRoots(env)).toEqual([]);
    expect(spy.reads).toEqual([]);
  });

  it('drops a networked root named inside the Dropbox config', () => {
    // The config file is trusted to locate, but its contents are still hints.
    const probe = dropboxProbePath();
    const roots = detectSyncRoots(
      environment({}, { [probe]: JSON.stringify({ business: { path: ATTACKER_UNC } }) }),
    );
    expect(roots).toEqual([]);
  });

  it.each([
    ['a UNC share', ATTACKER_UNC],
    ['a device path', '\\\\?\\D:\\attacker'],
    ['a relative path', 'attacker-relative'],
  ])('drops %s candidates from both Dropbox metadata files', (_label, value) => {
    const [local, roaming] = dropboxProbePaths();
    const { environment: env, spy } = spyEnvironment({}, {
      files: {
        [local ?? '']: JSON.stringify({ local: { path: value } }),
        [roaming ?? '']: JSON.stringify({ roaming: { path: value } }),
      },
    });

    expect(detectSyncRoots(env)).toEqual([]);
    expect(spy.reads).toEqual([local, roaming]);
  });

  it('ignores malformed Dropbox configuration instead of failing', () => {
    const probe = dropboxProbePath();
    expect(detectSyncRoots(environment({}, { [probe]: 'not json' }))).toEqual([]);
  });

  it('returns nothing when no sync client is present', () => {
    expect(detectSyncRoots(environment({}))).toEqual([]);
  });
});

describe('assertStateRootNotSynced: no probe for unusable candidates', () => {
  it('never resolves an attacker-supplied sync root', () => {
    const { environment: env, spy } = spyEnvironment({ OneDrive: ATTACKER_UNC });

    expect(() =>
      assertStateRootNotSynced('C:\\Users\\example\\.agent-orchestrator-mcp', env),
    ).not.toThrow();

    expect(spy.realpaths).not.toContain(ATTACKER_UNC);
    for (const probed of spy.realpaths) expect(probed.startsWith('\\\\')).toBe(false);
  });

  it('still checks a legitimate local sync root', () => {
    const root = 'D:\\OneDrive\\state';
    const { environment: env } = spyEnvironment(
      { OneDrive: 'D:\\OneDrive' },
      { realPaths: { [root]: root } },
    );
    expect(() => assertStateRootNotSynced(root, env)).toThrow(SecurityError);
  });
});

describe('isInside', () => {
  it('treats a path as inside itself', () => {
    expect(isInside('/a/b', '/a/b', 'linux')).toBe(true);
  });

  it('detects containment', () => {
    expect(isInside('/a/b/c', '/a/b', 'linux')).toBe(true);
  });

  it('rejects a sibling whose name shares a prefix', () => {
    expect(isInside('/a/bcd', '/a/b', 'linux')).toBe(false);
  });

  it('applies Windows separator and case rules on any host', () => {
    expect(
      isInside('C:\\Users\\Fixed\\OneDrive\\state', 'C:\\users\\fixed\\onedrive', 'win32'),
    ).toBe(true);
    expect(isInside('C:\\Users\\Fixed\\Other', 'C:\\Users\\Fixed\\OneDrive', 'win32')).toBe(false);
  });

  it('keeps POSIX case-sensitive on any host', () => {
    expect(isInside('/home/Fixed/sync/state', '/home/fixed/sync', 'linux')).toBe(false);
    expect(isInside('/home/fixed/sync/state', '/home/fixed/sync', 'linux')).toBe(true);
  });

  it('does not treat a prefix-sharing sibling as contained, on Windows paths', () => {
    expect(
      isInside('C:\\Users\\Fixed\\OneDriveOther', 'C:\\Users\\Fixed\\OneDrive', 'win32'),
    ).toBe(false);
  });
});

describe('assertStateRootNotSynced', () => {
  const ROOT = 'C:\\Users\\example\\.agent-orchestrator-mcp';

  it('passes when the state root is outside every sync root', () => {
    expect(() =>
      assertStateRootNotSynced(
        ROOT,
        environment({ OneDrive: 'C:\\Users\\example\\OneDrive' }),
      ),
    ).not.toThrow();
  });

  it('fails closed when the state root is inside a sync root, naming the provider', () => {
    try {
      assertStateRootNotSynced(
        'C:\\Users\\example\\OneDrive\\state',
        environment({ OneDrive: 'C:\\Users\\example\\OneDrive' }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SecurityError);
      expect((error as SecurityError).message).toContain('OneDrive');
      expect((error as SecurityError).remedy).toBeDefined();
    }
  });

  it('rejects a provider root equal to the state root', () => {
    expect(() => assertStateRootNotSynced(ROOT, environment({ OneDrive: ROOT }))).toThrow(
      SecurityError,
    );
  });

  it.each(['secrets', 'data', 'artifacts', 'logs'])(
    'rejects a provider root nested at stateRoot\\%s',
    (directory) => {
      const layout = stateLayout(ROOT, 'win32');
      const syncRoot = layout[directory as 'secrets' | 'data' | 'artifacts' | 'logs'];
      expect(() => assertStateRootNotSynced(ROOT, environment({ OneDrive: syncRoot }))).toThrow(
        SecurityError,
      );
    },
  );

  it('rejects a provider root equal to the protected lease key path', () => {
    const layout = stateLayout(ROOT, 'win32');
    expect(() => assertStateRootNotSynced(ROOT, environment({ OneDrive: layout.leaseKey }))).toThrow(
      SecurityError,
    );
  });

  it('performs nested-provider rejection lexically before any real-path probe', () => {
    const { environment: env, spy } = spyEnvironment({ OneDrive: `${ROOT}\\secrets` });

    expect(() => assertStateRootNotSynced(ROOT, env)).toThrow(SecurityError);
    expect(spy.realpaths).toEqual([]);
  });

  it('does not probe hostile environment or Dropbox candidates', () => {
    const [local, roaming] = dropboxProbePaths();
    const { environment: env, spy } = spyEnvironment(
      {
        OneDrive: ATTACKER_UNC,
        OneDriveConsumer: '\\\\?\\C:\\attacker',
        OneDriveCommercial: 'relative-attacker',
        USERPROFILE: ATTACKER_UNC,
        LOCALAPPDATA: '\\\\?\\C:\\attacker',
        APPDATA: 'relative-attacker',
      },
      {
        files: {
          [local ?? '']: JSON.stringify({ local: { path: ATTACKER_UNC } }),
          [roaming ?? '']: JSON.stringify({ roaming: { path: '\\\\?\\C:\\attacker' } }),
        },
      },
    );

    expect(() => assertStateRootNotSynced(ROOT, env)).not.toThrow();
    expect(spy.realpaths).toEqual([]);
    expect(spy.reads).toEqual([local, roaming]);
  });
});

describe('assertStateRootNotSynced: real-path pass', () => {
  const ONEDRIVE = 'C:\\Users\\example\\OneDrive';
  const ROOT = 'C:\\Users\\example\\.agent-orchestrator-mcp';

  function withRealPaths(realPaths: Record<string, string>): CloudSyncEnvironment {
    return spyEnvironment({ OneDrive: ONEDRIVE }, { realPaths }).environment;
  }

  it('passes when neither the name nor the resolved path is synchronised', () => {
    expect(() =>
      assertStateRootNotSynced(ROOT, withRealPaths({ [ROOT]: ROOT, [ONEDRIVE]: ONEDRIVE })),
    ).not.toThrow();
  });

  it('rejects a state root whose name looks safe but resolves into a sync root', () => {
    // The classic junction bypass: the literal path is outside OneDrive, but
    // the directory is a redirection into it.
    const env = withRealPaths({
      [ROOT]: `${ONEDRIVE}\\redirected\\state`,
      [ONEDRIVE]: ONEDRIVE,
    });
    expect(() => assertStateRootNotSynced(ROOT, env)).toThrow(/resolves inside/);
  });

  it('rejects a protected child whose real path resolves into a sync root', () => {
    const layout = stateLayout(ROOT, 'win32');
    const env = withRealPaths({
      [ROOT]: ROOT,
      [layout.secrets]: `${ONEDRIVE}\\redirected-secrets`,
      [ONEDRIVE]: ONEDRIVE,
    });
    expect(() => assertStateRootNotSynced(ROOT, env)).toThrow(/resolves inside/);
  });

  it('rejects when the sync root itself is a link containing the resolved state root', () => {
    const env = withRealPaths({ [ROOT]: 'D:\\Synced\\state', [ONEDRIVE]: 'D:\\Synced' });
    expect(() => assertStateRootNotSynced(ROOT, env)).toThrow(/resolves inside/);
  });

  it('rejects a sync root whose real path resolves below protected state', () => {
    const declared = 'D:\\ProviderLink';
    const env = spyEnvironment(
      { OneDrive: declared },
      { realPaths: { [ROOT]: ROOT, [declared]: `${ROOT}\\secrets` } },
    ).environment;
    expect(() => assertStateRootNotSynced(ROOT, env)).toThrow(/inside protected state path/);
  });

  it('compares resolved paths case-insensitively on Windows', () => {
    const env = withRealPaths({ [ROOT]: 'D:\\SYNCED\\State', [ONEDRIVE]: 'd:\\synced' });
    expect(() => assertStateRootNotSynced(ROOT, env)).toThrow(SecurityError);
  });

  it('falls back to the lexical check when the state root does not exist yet', () => {
    const env = withRealPaths({});
    expect(() => assertStateRootNotSynced(`${ONEDRIVE}\\state`, env)).toThrow(SecurityError);
    expect(() => assertStateRootNotSynced(ROOT, env)).not.toThrow();
  });

  it('still works when no real-path resolver is supplied at all', () => {
    expect(() =>
      assertStateRootNotSynced(`${ONEDRIVE}\\state`, environment({ OneDrive: ONEDRIVE })),
    ).toThrow(SecurityError);
  });
});
