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
      if (/authoritative_status\s*=/i.test(entry.text)) {
        expect(entry.path).toBe('src/domain/decide.ts');
      }
    }
  });

  it('REG-04 keeps Phase 5/6 tool names absent from the implementation source', () => {
    const root = process.cwd();
    const files = sourceFiles(join(root, 'src'));
    const all = files.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(all).not.toMatch(/job_create|job_get|job_list|qa_dispatch|run_report|audit_query/);
  });

  it('AUTH-05 keeps the legacy environment resolver out of the production CLI path', () => {
    const cli = readFileSync(join(process.cwd(), 'src', 'cli.ts'), 'utf8');
    expect(cli).not.toContain('createEnvironmentTokenResolver');
    expect(cli).not.toContain('startEnvironmentStdioServer');
    expect(cli).toContain('openPhase4Runtime');
  });
});
