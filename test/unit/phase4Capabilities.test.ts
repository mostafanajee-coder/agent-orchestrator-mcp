import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_VALUES,
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  parseCapabilities,
} from '../../src/authority/capabilities.js';

describe('Phase 4 capability catalogue', () => {
  it('CAP-01 keeps the reviewed seven-value catalogue and canonical ordering', () => {
    expect(CAPABILITY_VALUES).toEqual([
      'job:create',
      'job:read',
      'job:decide',
      'qa:request',
      'work:report',
      'evidence:add',
      'artifact:register',
    ]);
    expect(parseCapabilities('["job:decide","job:read"]')).toEqual(['job:decide', 'job:read']);
    expect(canonicalCapabilitiesJson(['job:read', 'job:decide'])).toBe('["job:decide","job:read"]');
  });

  it('CAP-02/CAP-03/CAP-04/CAP-05 rejects malformed and role-incompatible capabilities', () => {
    expect(() => parseCapabilities('{')).toThrow('valid JSON');
    expect(() => parseCapabilities('["job:read","job:read"]')).toThrow('duplicate-free');
    expect(() => parseCapabilities('["not-a-capability"]')).toThrow('duplicate-free');
    expect(() => assertRoleCapabilities('worker', ['job:decide'])).toThrow('incompatible');
    expect(() => assertRoleCapabilities('principal', [])).toThrow('job:decide');
    expect(() => assertRoleCapabilities('system', ['job:read'])).toThrow('incompatible');
  });
});
