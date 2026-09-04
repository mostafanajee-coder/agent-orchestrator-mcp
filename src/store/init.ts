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
import { AuditWriter } from '../authority/audit.js';
import { bootstrapProduction, type BootstrapResult } from '../authority/bootstrap.js';

export interface DatabaseInitResult {
  readonly created: boolean;
  readonly schemaVersion: 4 | 5 | 6 | 7 | 8 | 9;
  readonly appliedVersions: readonly number[];
  readonly bootstrap?: BootstrapResult;
}

export interface DatabaseInitDependencies extends DatabaseOpenDependencies {
  readonly migrationDirectory?: string;
  readonly migrations?: readonly Migration[];
  readonly phase4Bootstrap?: boolean;
}

/**
 * Initializes the schema on the explicit init path. Production Phase 4 actor,
 * token, and authority bootstrap is opt-out only for structural test fixtures.
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
    if (dependencies.phase4Bootstrap === true && integrity.schemaVersion !== 9) {
      throw new SecurityError(
        'Phase 10B.4 implementation requires schema version 9.',
        'Apply the complete approved migration set before bootstrapping authority.',
      );
    }
    const bootstrap = dependencies.phase4Bootstrap === true
      ? bootstrapProduction(opened.db, new AuditWriter(opened.db))
      : undefined;
    return {
      created: opened.fresh,
      schemaVersion: integrity.schemaVersion,
      appliedVersions: integrity.appliedVersions,
      ...(bootstrap === undefined ? {} : { bootstrap }),
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
            'Database initialization failed.',
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
