import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 0 is a scaffold. These tests fail the build if a later phase's
 * dependency is pulled in early, so scope creep is caught by CI rather than
 * by review.
 */

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;

/** Dependencies that belong to Phase 1 and later, per docs/ARCHITECTURE.md. */
const FUTURE_PHASE_PACKAGES = [
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/node',
  '@modelcontextprotocol/express',
  '@modelcontextprotocol/sdk',
  'zod',
  'better-sqlite3',
  '@types/better-sqlite3',
  'chrome-remote-interface',
  'puppeteer',
  'puppeteer-core',
  'playwright',
  'express',
];

describe('Phase 0 dependency scope', () => {
  it('declares no runtime dependencies', () => {
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it.each(FUTURE_PHASE_PACKAGES)('does not depend on %s', (name) => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(all)).not.toContain(name);
  });
});
