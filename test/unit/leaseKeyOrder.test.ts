import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeFs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecurityError } from '../../src/errors.js';
import type { AclReport, PathKind, SecurityProvider } from '../../src/security/provider.js';

/**
 * Proves the ordering invariant: an existing lease key must have its
 * protection verified BEFORE anything opens or reads it.
 *
 * `node:fs` is mocked so every open and read is recorded alongside the
 * verification calls, making the ordering observable.
 */
const trace = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    openSync: ((path: string, flags: string, mode?: number) => {
      trace.events.push(`open:${String(path)}`);
      return actual.openSync(path, flags, mode);
    }) as typeof actual.openSync,
    readFileSync: ((path: string, options?: unknown) => {
      trace.events.push(`read:${String(path)}`);
      return (actual.readFileSync as (p: string, o?: unknown) => unknown)(path, options);
    }) as typeof actual.readFileSync,
  };
});

const fs = await import('node:fs');
const { ensureLeaseKey } = await import('../../src/secrets/leaseKey.js');

class RecordingProvider implements SecurityProvider {
  public readonly kind = 'posix';
  public secure = true;

  public subject(): string {
    return 'test-subject';
  }

  public describe(): string {
    return 'recording provider';
  }

  public harden(path: string): void {
    trace.events.push(`harden:${path}`);
  }

  public verify(path: string, kind: PathKind): AclReport {
    trace.events.push(`verify:${path}`);
    return {
      path,
      kind,
      secure: this.secure,
      problems: this.secure ? [] : ['grants access to the broad identity Everyone'],
      detail: 'recording provider',
    };
  }
}

let directory: string;
let keyPath: string;

beforeEach(() => {
  trace.events.length = 0;
  directory = fs.mkdtempSync(join(tmpdir(), 'aomcp-order-'));
  keyPath = join(directory, 'lease.key');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('lease key access ordering', () => {
  it('records opens, proving the trace is wired up', () => {
    ensureLeaseKey(keyPath, new RecordingProvider());
    expect(trace.events).toContain(`open:${keyPath}`);
  });

  it('verifies protection before opening or reading an existing key', () => {
    fs.writeFileSync(keyPath, randomBytes(32));
    trace.events.length = 0;

    const provider = new RecordingProvider();
    const result = ensureLeaseKey(keyPath, provider);
    expect(result.created).toBe(false);

    const verifyIndex = trace.events.indexOf(`verify:${keyPath}`);
    expect(verifyIndex).toBeGreaterThanOrEqual(0);

    const accessIndex = trace.events.findIndex(
      (event) => event === `open:${keyPath}` || event === `read:${keyPath}`,
    );
    // Either nothing opened the key at all, or verification came first.
    expect(accessIndex === -1 || verifyIndex < accessIndex).toBe(true);
  });

  it('never opens or reads a key whose protection is unsafe', () => {
    fs.writeFileSync(keyPath, randomBytes(32));
    trace.events.length = 0;

    const provider = new RecordingProvider();
    provider.secure = false;

    expect(() => ensureLeaseKey(keyPath, provider)).toThrow(SecurityError);

    expect(trace.events).toContain(`verify:${keyPath}`);
    expect(trace.events).not.toContain(`open:${keyPath}`);
    expect(trace.events).not.toContain(`read:${keyPath}`);
    // It is refused, not repaired.
    expect(trace.events).not.toContain(`harden:${keyPath}`);
  });
});
