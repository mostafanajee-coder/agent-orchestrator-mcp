import { describe, expect, it } from 'vitest';

import { createLeaseMaterial, issueLease, verifyLease } from '../../src/workers/lease.js';

const KEY = Buffer.alloc(32, 7);
const IDS = {
  lease_id: '11111111-1111-4111-8111-111111111111',
  run_id: '22222222-2222-4222-8222-222222222222',
  job_id: '33333333-3333-4333-8333-333333333333',
  cycle: 2,
  actor_id: 'worker-local',
  expires_at: '2030-01-01T00:00:00.000Z',
};

describe('Phase 6 run leases', () => {
  it('issues and verifies a canonical run-scoped lease', () => {
    const issued = issueLease({ ...IDS, nonce: 'a'.repeat(64) }, KEY);
    expect(verifyLease(issued.token, KEY, Date.parse('2029-01-01T00:00:00Z'))).toEqual(issued.payload);
    expect(issued.token.split('.')).toHaveLength(2);
  });

  it('rejects tampering and expiry', () => {
    const issued = issueLease({ ...IDS, nonce: 'b'.repeat(64) }, KEY);
    const [payload, mac] = issued.token.split('.');
    expect(() => verifyLease(`${payload}.A${mac?.slice(1) ?? ''}`, KEY, Date.parse('2029-01-01T00:00:00Z'))).toThrow('invalid');
    expect(() => verifyLease(issued.token, KEY, Date.parse('2031-01-01T00:00:00Z'))).toThrow('expired');
    expect(verifyLease(issued.token, KEY, Date.parse('2031-01-01T00:00:00Z'), { allowExpired: true })).toEqual(issued.payload);
  });

  it('creates unique server-owned run and lease identifiers', () => {
    const first = createLeaseMaterial('worker-local', IDS.job_id, 0, IDS.expires_at, KEY);
    const second = createLeaseMaterial('worker-local', IDS.job_id, 0, IDS.expires_at, KEY);
    expect(first.runId).not.toBe(second.runId);
    expect(first.leaseId).not.toBe(second.leaseId);
    expect(first.nonce).not.toBe(second.nonce);
  });
});
