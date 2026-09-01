import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Phase 6 process-group policy', () => {
  it('isolates POSIX workers and signals the complete group', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'workers', 'processRuntime.ts'), 'utf8');
    expect(source).toContain('detached: process.platform !== \'win32\'');
    expect(source).toContain('process.kill(-child.pid, signal)');
    expect(source).toContain("taskkill', ['/pid', String(active.child.pid), '/t', '/f'");
  });
});
