import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads the version from the package manifest.
 *
 * The manifest sits one directory above this module in both layouts that
 * matter: `src/version.ts` and the compiled `dist/version.js`.
 */
export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, '..', 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error(`${manifestPath} has no string "version" field`);
  }

  return parsed.version;
}
