import type { CommandContext } from '../commands/context.js';
import { SecurityError } from '../errors.js';
import {
  closeDatabase,
  openDatabaseForInit,
  removeFreshDatabaseFiles,
} from './db.js';
import { runMigrations } from './migrations.js';
import { verifyDatabaseIntegrity } from './integrity.js';

export interface DatabaseInitResult {
  readonly created: boolean;
  readonly schemaVersion: number;
  readonly appliedVersions: readonly number[];
}

/**
 * Initializes only the schema on the explicit init path. Production actors,
 * tokens, and authority activation remain Phase 4.
 */
export function initializeDatabaseForInit(context: CommandContext): DatabaseInitResult {
  const opened = openDatabaseForInit(context);
  try {
    runMigrations(opened.db, { fresh: opened.fresh });
    const integrity = verifyDatabaseIntegrity(opened.db);
    return {
      created: opened.fresh,
      schemaVersion: integrity.schemaVersion,
      appliedVersions: integrity.appliedVersions,
    };
  } catch (cause) {
    if (opened.fresh) {
      try {
        removeFreshDatabaseFiles(context.layout);
      } catch {
        // Preserve the original failure; exact cleanup state remains inspectable.
      }
    }
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Phase 3 database initialization failed.',
      'Inspect the database security and migration state, then retry init.',
    );
  } finally {
    closeDatabase(opened.db);
  }
}
