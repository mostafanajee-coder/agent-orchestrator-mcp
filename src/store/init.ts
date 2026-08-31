import type { CommandContext } from '../commands/context.js';
import { SecurityError } from '../errors.js';
import {
  closeDatabase,
  openDatabaseForInit,
  removeFreshDatabaseFiles,
  type DatabaseOpenDependencies,
} from './db.js';
import { runMigrations, type Migration } from './migrations.js';
import { verifyDatabaseIntegrity } from './integrity.js';

export interface DatabaseInitResult {
  readonly created: boolean;
  readonly schemaVersion: number;
  readonly appliedVersions: readonly number[];
}

export interface DatabaseInitDependencies extends DatabaseOpenDependencies {
  readonly migrationDirectory?: string;
  readonly migrations?: readonly Migration[];
}

/**
 * Initializes only the schema on the explicit init path. Production actors,
 * tokens, and authority activation remain Phase 4.
 */
export function initializeDatabaseForInit(
  context: CommandContext,
  dependencies: DatabaseInitDependencies = {},
): DatabaseInitResult {
  const opened = openDatabaseForInit(context, dependencies);
  try {
    const migrationOptions = {
      fresh: opened.fresh,
      ...(dependencies.migrationDirectory === undefined
        ? {}
        : { directory: dependencies.migrationDirectory }),
      ...(dependencies.migrations === undefined ? {} : { migrations: dependencies.migrations }),
    };
    runMigrations(opened.db, migrationOptions);
    const integrity = verifyDatabaseIntegrity(opened.db);
    return {
      created: opened.fresh,
      schemaVersion: integrity.schemaVersion,
      appliedVersions: integrity.appliedVersions,
    };
  } catch (cause) {
    const original = cause instanceof SecurityError
      ? cause
      : cause instanceof Error
        ? new SecurityError(
            cause.message,
            'Inspect the database security and migration state, then retry init.',
          )
        : new SecurityError(
            'Phase 3 database initialization failed.',
            'Inspect the database security and migration state, then retry init.',
          );
    let cleanupFailure: unknown;
    if (opened.fresh) {
      try {
        closeDatabase(opened.db);
      } catch {
        // Preserve the original failure and continue to best-effort cleanup.
      }
      try {
        removeFreshDatabaseFiles(context.layout, opened.freshFiles);
      } catch (cleanupCause) {
        cleanupFailure = cleanupCause;
      }
    }
    if (cleanupFailure !== undefined) {
      const cleanupDetail = cleanupFailure instanceof Error
        ? cleanupFailure.message
        : 'the cleanup operation failed';
      throw new SecurityError(
        original.message,
        (original.remedy ?? 'Inspect the database security and migration state, then retry init.') +
          ' The fresh-init cleanup also failed: ' + cleanupDetail,
      );
    }
    throw original;
  } finally {
    closeDatabase(opened.db);
  }
}
