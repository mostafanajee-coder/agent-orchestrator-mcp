import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readPackageVersion } from '../../src/version.js';

describe('readPackageVersion', () => {
  it('returns the version declared in package.json', () => {
    const manifest: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
    const declared = (manifest as { version: string }).version;

    expect(readPackageVersion()).toBe(declared);
  });

  it('returns a dotted version string', () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
