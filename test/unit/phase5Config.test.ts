import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultPhase5Config,
  ensurePhase5Config,
  loadPhase5Config,
} from '../../src/config/phase5.js';
import {
  closeStoreFixture,
  createStoreFixture,
  type StoreFixture,
} from '../store/testHelpers.js';

let fixture: StoreFixture;

beforeEach(() => {
  fixture = createStoreFixture();
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('Phase 5 protected runtime configuration', () => {
  it('creates and loads the platform defaults through init', () => {
    const expected = defaultPhase5Config(process.platform);
    const onDisk = JSON.parse(readFileSync(fixture.layout.configFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({
      workspace_roots: [...expected.workspaceRoots],
      default_max_cycles: expected.defaultMaxCycles,
      hard_max_cycles: expected.hardMaxCycles,
      default_stale_after_s: expected.defaultStaleAfterS,
    });
    expect(loadPhase5Config(fixture.context)).toEqual(expected);
  });

  it('loads operator-edited roots and bounded defaults without a source change', () => {
    const configuredRoot = join(fixture.workspace, 'configured-root');
    mkdirSync(configuredRoot);
    writeFileSync(fixture.layout.configFile, JSON.stringify({
      workspace_roots: [fixture.workspace],
      default_max_cycles: 2,
      hard_max_cycles: 4,
      default_stale_after_s: 120,
    }), 'utf8');

    expect(loadPhase5Config(fixture.context)).toEqual({
      workspaceRoots: [fixture.workspace],
      defaultMaxCycles: 2,
      hardMaxCycles: 4,
      defaultStaleAfterS: 120,
    });
    expect(ensurePhase5Config(fixture.context)).toEqual({
      workspaceRoots: [fixture.workspace],
      defaultMaxCycles: 2,
      hardMaxCycles: 4,
      defaultStaleAfterS: 120,
    });
  });

  it('fails closed for malformed or overly broad configuration', () => {
    writeFileSync(fixture.layout.configFile, '{not-json', 'utf8');
    expect(() => loadPhase5Config(fixture.context)).toThrow('not valid JSON');

    const broadRoot = process.platform === 'win32' ? 'C:\\' : '/';
    writeFileSync(fixture.layout.configFile, JSON.stringify({
      workspace_roots: [broadRoot],
      default_max_cycles: 2,
      hard_max_cycles: 4,
      default_stale_after_s: 120,
    }), 'utf8');
    expect(() => loadPhase5Config(fixture.context)).toThrow('non-root');
  });
});
