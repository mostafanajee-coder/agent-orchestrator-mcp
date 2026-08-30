import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
cpSync(
  join(root, 'src', 'store', 'migrations'),
  join(root, 'dist', 'store', 'migrations'),
  { recursive: true },
);
