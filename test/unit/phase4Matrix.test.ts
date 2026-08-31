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

    for (const entry of contents) {
      if (/UPDATE\s+jobs\s+SET[^\r\n]*\bauthoritative_status\s*=(?!=)/i.test(entry.text)) {
        expect(entry.path).toBe('src/domain/decide.ts');
      }
    }
  });

  it('REG-04 exposes the Phase 5 lifecycle names without leaking Phase 6+ tools', () => {
    const root = process.cwd();
    const files = sourceFiles(join(root, 'src'));
    const all = files.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(all).toMatch(/job_create|job_get|job_list|job_start|job_resume/);
    expect(all).not.toMatch(/qa_dispatch|run_report|audit_query/);
  });

  it('AUTH-05 keeps the legacy environment resolver out of the production CLI path', () => {
    const cli = readFileSync(join(process.cwd(), 'src', 'cli.ts'), 'utf8');
    expect(cli).not.toContain('createEnvironmentTokenResolver');
    expect(cli).not.toContain('startEnvironmentStdioServer');
    expect(cli).toContain('openPhase4Runtime');
  });
});
