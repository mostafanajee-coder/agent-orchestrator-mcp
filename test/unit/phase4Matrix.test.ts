import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('Phase 4 matrix traceability', () => {
  it('O2-01 has a source-level durable-write and sole-authoritative-writer gate', () => {
    const root = process.cwd();
    const files = sourceFiles(join(root, 'src'));
    const contents = files.map((path) => ({
      path: relative(root, path).replaceAll('\\', '/'),
      text: readFileSync(path, 'utf8'),
    }));
    const all = contents.map((entry) => entry.text).join('\n');
    expect(all).not.toMatch(/INSERT\s+OR\s+REPLACE|REPLACE\s+INTO|ON\s+CONFLICT/i);

    const phase5NullInsertPath = 'src/domain/jobs.ts';
    for (const entry of contents) {
      const assignments = [...entry.text.matchAll(/\bauthoritative_status\s*=(?!=)/gi)];
      for (const assignment of assignments) {
        // Phase 5 creates jobs with authoritative_status hard-coded to null;
        // it never assigns an authoritative value. All other assignments must
        // remain in the Phase 4 decision choke point.
        const before = entry.text.slice(0, assignment.index);
        const phase5NullInsert = entry.path === phase5NullInsertPath
          && /authoritative_status:\s*null/.test(entry.text)
          && /INSERT INTO jobs/i.test(before.slice(Math.max(0, before.length - 2_000)));
        if (phase5NullInsert) continue;
        expect(entry.path).toBe('src/domain/decide.ts');
      }
    }
  });

  it('REG-04 exposes the Phase 5–8 names without leaking later integrations', () => {
    const root = process.cwd();
    const files = sourceFiles(join(root, 'src'));
    const all = files.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(all).toMatch(/job_create|job_get|job_list|job_start|job_resume/);
    expect(all).toMatch(/qa_dispatch|run_report|run_status/);
    expect(all).toMatch(/evidence_add|artifact_register|evidence_list|artifact_list/);
    expect(all).toMatch(/audit_query|Phase8Lifecycle|reapStaleRuns/);
    expect(all).not.toMatch(/remote_worker/);
  });

  it('AUTH-05 keeps the legacy environment resolver out of the production CLI path', () => {
    const cli = readFileSync(join(process.cwd(), 'src', 'cli.ts'), 'utf8');
    expect(cli).not.toContain('createEnvironmentTokenResolver');
    expect(cli).not.toContain('startEnvironmentStdioServer');
    expect(cli).toContain('openPhase4Runtime');
  });
});
