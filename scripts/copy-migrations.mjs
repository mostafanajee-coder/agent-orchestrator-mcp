import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDestination = join(root, 'dist', 'store', 'migrations');
rmSync(migrationDestination, { recursive: true, force: true });
cpSync(
  join(root, 'src', 'store', 'migrations'),
  migrationDestination,
  { recursive: true },
);
