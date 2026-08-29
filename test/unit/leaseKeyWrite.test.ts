import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecurityError } from '../../src/errors.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';

/**
 * `writeSync` may legitimately accept fewer bytes than it was given, so the
 * key writer must honour its return value rather than assume one call wrote
 * everything. `node:fs` is mocked to force that situation.
 */
const control = vi.hoisted(() => ({ chunkSize: 0, refuse: false, calls: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    writeSync: ((fd: number, buffer: Buffer, offset?: number, length?: number) => {
      control.calls += 1;
      if (control.refuse) return 0;
      const start = offset ?? 0;
      const full = length ?? buffer.length - start;
      const limited = control.chunkSize > 0 ? Math.min(control.chunkSize, full) : full;
      return actual.writeSync(fd, buffer, start, limited);
    }) as typeof actual.writeSync,
  };
});

const fs = await import('node:fs');
const { ensureLeaseKey, LEASE_KEY_BYTES } = await import('../../src/secrets/leaseKey.js');

let directory: string;
let keyPath: string;
let security: FakeSecurityProvider;

beforeEach(() => {
  control.chunkSize = 0;
  control.refuse = false;
  control.calls = 0;
  directory = fs.mkdtempSync(join(tmpdir(), 'aomcp-write-'));
  keyPath = join(directory, 'lease.key');
  security = new FakeSecurityProvider();
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('lease key write completeness', () => {
  it('completes the key when every write is short', () => {
    control.chunkSize = 7; // 32 bytes cannot arrive in one call

    ensureLeaseKey(keyPath, security);

    expect(fs.lstatSync(keyPath).size).toBe(LEASE_KEY_BYTES);
    expect(control.calls).toBeGreaterThan(1);
  });

  it('completes the key when writes accept a single byte at a time', () => {
    control.chunkSize = 1;
    ensureLeaseKey(keyPath, security);
    expect(fs.lstatSync(keyPath).size).toBe(LEASE_KEY_BYTES);
    expect(control.calls).toBeGreaterThanOrEqual(LEASE_KEY_BYTES);
  });

  it('fails closed and leaves no partial key when writes stop making progress', () => {
    control.refuse = true;

    expect(() => ensureLeaseKey(keyPath, security)).toThrow(SecurityError);
    expect(() => ensureLeaseKey(keyPath, security)).toThrow(/could not be written in full/);
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('leaves no partial key when only part of the key is written', () => {
    // Accept the first chunk, then stall: the file exists but is short.
    control.chunkSize = 8;
    let seen = 0;
    const original = control.refuse;
    Object.defineProperty(control, 'refuse', {
      get: () => {
        seen += 1;
        return seen > 1;
      },
      configurable: true,
    });

    try {
      expect(() => ensureLeaseKey(keyPath, security)).toThrow(SecurityError);
      expect(fs.existsSync(keyPath)).toBe(false);
    } finally {
      Object.defineProperty(control, 'refuse', { value: original, writable: true, configurable: true });
    }
  });
});
