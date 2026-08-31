import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Phase 3 adds only the approved SQLite persistence dependency. */

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;

const PHASE_3_PACKAGES = {
  '@modelcontextprotocol/server': '2.0.0',
  '@modelcontextprotocol/node': '2.0.0',
  'better-sqlite3': '13.0.3',
  zod: '4.5.4',
};

/** Packages reserved for later phases or explicitly forbidden by the architecture. */
const FORBIDDEN_PHASE_PACKAGES = [
  '@modelcontextprotocol/express',
  '@modelcontextprotocol/sdk',
  'chrome-remote-interface',
  'puppeteer',
  'puppeteer-core',
  'playwright',
  'express',
];

describe('Phase 3 dependency scope', () => {
  it('declares the verified exact Phase 3 runtime dependencies', () => {
    expect(manifest.dependencies ?? {}).toEqual(PHASE_3_PACKAGES);
  });

  it('declares only the matching development typings in addition to runtime dependencies', () => {
    expect(manifest.devDependencies?.['@types/better-sqlite3']).toBeDefined();
  });

  it.each(FORBIDDEN_PHASE_PACKAGES)('does not depend on %s', (name) => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(all)).not.toContain(name);
  });
});
