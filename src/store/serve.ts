import type { CommandContext } from '../commands/context.js';
import { SecurityError } from '../errors.js';
import { closeDatabase, openExistingDatabaseForServe } from './db.js';
import { verifyDatabaseIntegrity } from './integrity.js';
import { runMigrations } from './migrations.js';

/**
 * Opens only an existing authoritative DB, applies approved pending migrations,
 * and verifies the complete structural Phase 3 contract before MCP serving.
 */
export function assertDatabaseReadyForServe(context: CommandContext): void {
  const opened = openExistingDatabaseForServe(context);
  try {
    runMigrations(opened.db, { fresh: false });
    verifyDatabaseIntegrity(opened.db);
  } catch (cause) {
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Phase 3 database startup verification failed.',
      'Inspect the authoritative database and apply only an approved recovery.',
    );
  } finally {
    closeDatabase(opened.db);
  }
}
