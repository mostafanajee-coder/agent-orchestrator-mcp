import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const sourceDirectory = join(root, 'src', 'store', 'migrations');
const destinationDirectory = join(root, 'dist', 'store', 'migrations');
const stalePath = join(destinationDirectory, '004_stale_leftover.sql');

afterEach(() => {
  rmSync(stalePath, { force: true });
});

describe('migration build assets', () => {
  it('clears stale dist migrations before copying the approved source set', () => {
    mkdirSync(destinationDirectory, { recursive: true });
    writeFileSync(stalePath, 'SELECT 1;');

    execFileSync(process.execPath, ['scripts/copy-migrations.mjs'], {
      cwd: root,
      stdio: 'pipe',
    });

    const sourceNames = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const destinationNames = readdirSync(destinationDirectory).sort();
    expect(destinationNames).toEqual(sourceNames);
    expect(existsSync(stalePath)).toBe(false);
    expect(sourceNames).toEqual([
      '001_base_schema.sql',
      '002_authority_reference_seed_and_triggers.sql',
      '003_job_row_integrity_and_schema_verification.sql',
      '004_row_replacement_integrity.sql',
      '005_audit_sequence_guard_correction.sql',
      '006_actor_token_immutability.sql',
      '007_evidence_artifact_integrity.sql',
      '008_integration_generation_foundation.sql',
    ]);
  });
});
