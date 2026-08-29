import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecurityError } from '../../src/errors.js';
import { LEASE_KEY_BYTES, ensureLeaseKey, inspectLeaseKey } from '../../src/secrets/leaseKey.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';

let directory: string;
let keyPath: string;
let security: FakeSecurityProvider;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aomcp-lease-'));
  keyPath = join(directory, 'lease.key');
  security = new FakeSecurityProvider();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('ensureLeaseKey', () => {
  it('creates a 256-bit key', () => {
    const result = ensureLeaseKey(keyPath, security);
    expect(result.created).toBe(true);
    expect(readFileSync(keyPath).length).toBe(LEASE_KEY_BYTES);
    expect(LEASE_KEY_BYTES * 8).toBe(256);
  });

  it('hardens and verifies the key it creates', () => {
    ensureLeaseKey(keyPath, security);
    expect(security.hardened).toContainEqual({ path: keyPath, kind: 'file' });
    expect(security.verified).toContain(keyPath);
  });

  it('preserves an existing key across repeated runs', () => {
    ensureLeaseKey(keyPath, security);
    const first = readFileSync(keyPath);

    const second = ensureLeaseKey(keyPath, security);
    expect(second.created).toBe(false);
    expect(readFileSync(keyPath).equals(first)).toBe(true);
  });

  it('produces a different key in a different state root', () => {
    const other = mkdtempSync(join(tmpdir(), 'aomcp-lease-'));
    try {
      ensureLeaseKey(keyPath, security);
      ensureLeaseKey(join(other, 'lease.key'), new FakeSecurityProvider());
      expect(readFileSync(keyPath).equals(readFileSync(join(other, 'lease.key')))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it.each([0, 1, 16, 31, 33, 64, 4096])(
    'refuses an existing key of %i bytes, since exactly 32 is the format',
    (size) => {
      writeFileSync(keyPath, randomBytes(size));
      security.harden(keyPath, 'file');
      expect(() => ensureLeaseKey(keyPath, security)).toThrow(SecurityError);
      expect(() => ensureLeaseKey(keyPath, security)).toThrow(/exactly 32/);
    },
  );

  it('refuses an existing key whose protection is unsafe', () => {
    writeFileSync(keyPath, randomBytes(LEASE_KEY_BYTES));
    security.harden(keyPath, 'file');
    security.forcedInsecure.add(keyPath);

    expect(() => ensureLeaseKey(keyPath, security)).toThrow(SecurityError);
    // The key is left exactly as found: refused, never repaired.
    expect(existsSync(keyPath)).toBe(true);
  });

  it('leaves no partial key behind when hardening fails', () => {
    const failing = new FakeSecurityProvider();
    failing.harden = (): never => {
      throw new Error('icacls unavailable');
    };

    expect(() => ensureLeaseKey(keyPath, failing)).toThrow('icacls unavailable');
    expect(existsSync(keyPath)).toBe(false);
  });

  it('leaves no partial key behind when post-creation verification fails', () => {
    const failing = new FakeSecurityProvider();
    const originalHarden = failing.harden.bind(failing);
    failing.harden = (path, kind): void => {
      originalHarden(path, kind);
      failing.forcedInsecure.add(path);
    };

    expect(() => ensureLeaseKey(keyPath, failing)).toThrow(SecurityError);
    expect(existsSync(keyPath)).toBe(false);
  });

  it('never puts key material in an error message', () => {
    ensureLeaseKey(keyPath, security);
    const keyHex = readFileSync(keyPath).toString('hex');
    security.forcedInsecure.add(keyPath);

    try {
      ensureLeaseKey(keyPath, security);
      expect.unreachable();
    } catch (error) {
      const text = `${(error as Error).message} ${String((error as SecurityError).remedy)}`;
      expect(text).not.toContain(keyHex);
      expect(text).not.toContain(readFileSync(keyPath).toString('base64'));
    }
  });
});

describe('inspectLeaseKey', () => {
  it('reports a missing key without creating one', () => {
    const status = inspectLeaseKey(keyPath, security);
    expect(status).toEqual({
      present: false,
      secure: false,
      sizeBytes: undefined,
      problems: ['the lease key is missing'],
    });
    expect(existsSync(keyPath)).toBe(false);
  });

  it('reports a healthy key by size only', () => {
    ensureLeaseKey(keyPath, security);
    const status = inspectLeaseKey(keyPath, security);
    expect(status.present).toBe(true);
    expect(status.secure).toBe(true);
    expect(status.sizeBytes).toBe(LEASE_KEY_BYTES);
    expect(status.problems).toEqual([]);
  });

  it('reports an unsafe key without repairing it', () => {
    ensureLeaseKey(keyPath, security);
    security.forcedInsecure.add(keyPath);

    const status = inspectLeaseKey(keyPath, security);
    expect(status.secure).toBe(false);
    expect(status.problems.join(' ')).toContain('Everyone');
    expect(existsSync(keyPath)).toBe(true);
  });

  it('reports a malformed key', () => {
    writeFileSync(keyPath, randomBytes(8));
    security.harden(keyPath, 'file');
    const status = inspectLeaseKey(keyPath, security);
    expect(status.secure).toBe(false);
    expect(status.problems.join(' ')).toContain('exactly 32');
  });

  it('never returns key material', () => {
    ensureLeaseKey(keyPath, security);
    const status = inspectLeaseKey(keyPath, security);
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain(readFileSync(keyPath).toString('hex'));
    expect(Object.keys(status)).toEqual(['present', 'secure', 'sizeBytes', 'problems']);
  });
});
