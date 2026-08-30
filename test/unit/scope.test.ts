import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2 owns only the official MCP server/node adapters and schema runtime.
 * These tests keep Phase 3+ dependencies out of the spine.
 */

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;

const PHASE_2_PACKAGES = {
  '@modelcontextprotocol/server': '2.0.0',
  '@modelcontextprotocol/node': '2.0.0',
  zod: '4.5.4',
};

/** Packages reserved for Phase 3+ or explicitly forbidden by the architecture. */
const FORBIDDEN_PHASE_PACKAGES = [
  '@modelcontextprotocol/express',
  '@modelcontextprotocol/sdk',
  'better-sqlite3',
  '@types/better-sqlite3',
  'chrome-remote-interface',
  'puppeteer',
  'puppeteer-core',
  'playwright',
  'express',
];

describe('Phase 2 dependency scope', () => {
  it('declares the verified exact Phase 2 runtime dependencies', () => {
    expect(manifest.dependencies ?? {}).toEqual(PHASE_2_PACKAGES);
  });

  it.each(FORBIDDEN_PHASE_PACKAGES)('does not depend on %s', (name) => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(all)).not.toContain(name);
  });
});
