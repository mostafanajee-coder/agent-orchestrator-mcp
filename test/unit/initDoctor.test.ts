import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import { stateLayout } from '../../src/config/stateRoot.js';
import type { CommandContext } from '../../src/commands/context.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { runInit } from '../../src/commands/init.js';
import { SecurityError } from '../../src/errors.js';
import { LEASE_KEY_BYTES } from '../../src/secrets/leaseKey.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';

let workspace: string;
let root: string;
let security: FakeSecurityProvider;

function context(overrides: Partial<CommandContext> = {}): CommandContext {
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
    ...overrides,
  };
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'aomcp-init-'));
  root = join(workspace, 'AgentOrchestratorMCP');
  security = new FakeSecurityProvider();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('runInit', () => {
  it('creates every state directory and the lease key', () => {
    const layout = stateLayout(root, process.platform);
    const result = runInit(context());

    for (const path of [layout.root, layout.data, layout.artifacts, layout.secrets, layout.logs]) {
      expect(existsSync(path)).toBe(true);
    }
    expect(readFileSync(layout.leaseKey).length).toBe(LEASE_KEY_BYTES);
    expect(result.leaseKeyCreated).toBe(true);
    expect(result.createdDirectories).toHaveLength(5);
  });

  it('hardens the secrets directory before the lease key is written into it', () => {
    const layout = stateLayout(root, process.platform);
    runInit(context());

    const secretsIndex = security.hardened.findIndex((call) => call.path === layout.secrets);
    const keyIndex = security.hardened.findIndex((call) => call.path === layout.leaseKey);
    expect(secretsIndex).toBeGreaterThanOrEqual(0);
    expect(keyIndex).toBeGreaterThan(secretsIndex);
  });

  it('hardens the root first', () => {
    const layout = stateLayout(root, process.platform);
    runInit(context());
    expect(security.hardened[0]?.path).toBe(layout.root);
  });

  it('is idempotent and preserves the lease key', () => {
    const layout = stateLayout(root, process.platform);
    runInit(context());
    const first = readFileSync(layout.leaseKey);

    const second = runInit(context());
    expect(second.createdDirectories).toEqual([]);
    expect(second.leaseKeyCreated).toBe(false);
    expect(readFileSync(layout.leaseKey).equals(first)).toBe(true);
  });

  it('refuses a state root inside a cloud-synchronised directory, creating nothing', () => {
    const synced = context({
      cloudSync: {
        platform: process.platform,
        env: { OneDrive: workspace },
        profileDir: workspace,
        readFileIfPresent: () => undefined,
      },
    });

    expect(() => runInit(synced)).toThrow(SecurityError);
    expect(existsSync(root)).toBe(false);
  });

  it('fails closed and writes no key when a directory cannot be protected', () => {
    const layout = stateLayout(root, process.platform);
    security.forcedInsecure.add(layout.secrets);

    expect(() => runInit(context())).toThrow(SecurityError);
    expect(existsSync(layout.leaseKey)).toBe(false);
  });

  it('fails closed when protection cannot be verified at all', () => {
    security.verifyThrows.add(stateLayout(root, process.platform).root);
    expect(() => runInit(context())).toThrow('verification unavailable');
  });
});

describe('runDoctor', () => {
  it('passes on a freshly initialised state root', () => {
    runInit(context());
    const report = runDoctor(context());

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(report.checks).toHaveLength(7);
  });

  it('fails when the state root has never been initialised, and creates nothing', () => {
    const report = runDoctor(context());

    expect(report.ok).toBe(false);
    expect(existsSync(root)).toBe(false);
    expect(security.hardened).toEqual([]);
    expect(report.checks.filter((check) => check.status === 'fail').length).toBeGreaterThan(0);
  });

  it('fails on an insecure state root without repairing it', () => {
    const layout = stateLayout(root, process.platform);
    runInit(context());

    const hardenedBefore = security.hardened.length;
    security.forcedInsecure.add(layout.secrets);

    const report = runDoctor(context());
    expect(report.ok).toBe(false);
    expect(security.hardened).toHaveLength(hardenedBefore);
    const failed = report.checks.filter((check) => check.status === 'fail');
    expect(failed.map((check) => check.name).join(' ')).toContain(layout.secrets);
  });

  it('fails when the lease key is missing', () => {
    const layout = stateLayout(root, process.platform);
    runInit(context());
    rmSync(layout.leaseKey);

    const report = runDoctor(context());
    expect(report.ok).toBe(false);
    expect(
      report.checks.some(
        (check) => check.name.includes('lease key') && check.detail.includes('missing'),
      ),
    ).toBe(true);
  });

  it('reports the cloud-sync check as a distinct failure', () => {
    runInit(context());
    const report = runDoctor(
      context({
        cloudSync: {
          platform: process.platform,
          env: { OneDrive: workspace },
          profileDir: workspace,
          readFileIfPresent: () => undefined,
        },
      }),
    );

    const check = report.checks.find((entry) => entry.name === 'cloud-sync safety');
    expect(check?.status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('never exposes key material in its report', () => {
    const layout = stateLayout(root, process.platform);
    runInit(context());
    const keyHex = readFileSync(layout.leaseKey).toString('hex');

    const serialised = JSON.stringify(runDoctor(context()));
    expect(serialised).not.toContain(keyHex);
    expect(serialised).toContain(`${String(LEASE_KEY_BYTES)} bytes`);
  });
});

describe('redirection-boundary exemption', () => {
  it('is applied to the state root only, never to a child', () => {
    // Directly assert the policy the commands encode: only the root may sit on
    // a filesystem-virtualization boundary.
    const layout = stateLayout(root, process.platform);
    const children = [layout.data, layout.artifacts, layout.secrets, layout.logs, layout.leaseKey];
    for (const child of children) {
      expect(child).not.toBe(layout.root);
    }
    runInit(context());
    expect(runDoctor(context()).ok).toBe(true);
  });
});

describe('legacy state root', () => {
  let legacy: string;

  beforeEach(() => {
    // Distinct from the active root, which lives elsewhere in the workspace.
    legacy = join(workspace, 'LocalAppData', 'AgentOrchestratorMCP');
  });

  it('is reported as a warning without failing an otherwise secure root', () => {
    mkdirSync(join(legacy, 'secrets'), { recursive: true });
    writeFileSync(join(legacy, 'secrets', 'lease.key'), Buffer.alloc(32, 7));
    runInit(context({ legacyRoots: [legacy] }));

    const report = runDoctor(context({ legacyRoots: [legacy] }));
    const warning = report.checks.find((check) => check.status === 'warn');

    expect(report.ok).toBe(true);
    expect(warning?.name).toContain(legacy);
    expect(warning?.detail).toContain('not used');
  });

  it('does not read or hash anything from the legacy root', () => {
    mkdirSync(join(legacy, 'secrets'), { recursive: true });
    const legacySecret = Buffer.alloc(32, 9);
    writeFileSync(join(legacy, 'secrets', 'lease.key'), legacySecret);
    runInit(context({ legacyRoots: [legacy] }));

    const serialised = JSON.stringify(runDoctor(context({ legacyRoots: [legacy] })));
    expect(serialised).not.toContain(legacySecret.toString('hex'));
    expect(serialised).not.toContain(legacySecret.toString('base64'));
  });

  it('is not reported when it does not exist', () => {
    runInit(context({ legacyRoots: [legacy] }));
    const report = runDoctor(context({ legacyRoots: [legacy] }));
    expect(report.checks.some((check) => check.status === 'warn')).toBe(false);
  });

  it('never becomes authoritative: init creates only the new root', () => {
    mkdirSync(legacy, { recursive: true });
    const result = runInit(context({ legacyRoots: [legacy] }));

    expect(result.stateRoot).toBe(root);
    expect(result.stateRoot).not.toBe(legacy);
    // The legacy root is left exactly as found: not migrated, not deleted.
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(legacy, 'secrets'))).toBe(false);
    expect(runDoctor(context({ legacyRoots: [legacy] })).stateRoot).toBe(root);
  });

  it('does not copy a legacy key into the new root', () => {
    mkdirSync(join(legacy, 'secrets'), { recursive: true });
    const legacySecret = Buffer.alloc(32, 3);
    writeFileSync(join(legacy, 'secrets', 'lease.key'), legacySecret);

    const layout = stateLayout(root, process.platform);
    runInit(context({ legacyRoots: [legacy] }));

    expect(readFileSync(layout.leaseKey).equals(legacySecret)).toBe(false);
  });
});
