import type { CommandContext } from '../commands/context.js';
import { runDoctor, type DoctorReport } from '../commands/doctor.js';
import { SecurityError } from '../errors.js';
import {
  closeDatabase,
  openExistingDatabaseForServe,
  type SqliteDatabase,
} from '../store/db.js';
import { verifyDatabaseIntegrity } from '../store/integrity.js';
import { runMigrations } from '../store/migrations.js';
import { createPersistentTokenResolver, type PersistentTokenResolver } from '../mcp/persistentAuth.js';

import { AuditWriter, verifyAuditChain } from './audit.js';
import { validatePhase4State, type Phase4StateReport, type Phase4StateValidationOptions } from './state.js';

export interface Phase4ManagementRuntime {
  readonly db: SqliteDatabase;
  readonly audit: AuditWriter;
  readonly state: Phase4StateReport;
  readonly close: () => void;
}

export interface Phase4Runtime extends Phase4ManagementRuntime {
  readonly resolver: PersistentTokenResolver;
}

function assertDoctorPassed(report: DoctorReport): void {
  if (report.ok) return;
  const failures = report.checks
    .filter((check) => check.status === 'fail')
    .map((check) => check.name + ': ' + check.detail)
    .join('; ');
  throw new SecurityError(
    'MCP serve refused because Phase 1 security verification failed: ' + failures,
    'Resolve every reported filesystem/security failure and retry serve. No state was repaired automatically.',
  );
}

function openVerifiedDatabase(context: CommandContext): SqliteDatabase {
  assertDoctorPassed(runDoctor(context));
  const opened = openExistingDatabaseForServe(context);
  try {
    runMigrations(opened.db, { fresh: false });
    const integrity = verifyDatabaseIntegrity(opened.db);
    if (integrity.schemaVersion !== 6) {
      throw new SecurityError(
        'Phase 4 requires the database to reach schema version 6 before serving.',
        'Run the approved Phase 4 init/migration path and retry serve.',
      );
    }
    const chain = verifyAuditChain(opened.db);
    if (!chain.valid) {
      throw new SecurityError(
        'The Phase 4 audit chain is invalid at sequence ' + String(chain.firstInvalidSeq ?? 'unknown') + '.',
        'Restore the authoritative database through the approved recovery process; the audit chain is never repaired automatically.',
      );
    }
    return opened.db;
  } catch (cause) {
    closeDatabase(opened.db);
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Phase 4 startup verification failed.',
      cause instanceof Error ? cause.message : 'Inspect the database and retry.',
    );
  }
}

function buildManagementRuntime(
  context: CommandContext,
  stateOptions: Phase4StateValidationOptions,
): Phase4ManagementRuntime {
  const db = openVerifiedDatabase(context);
  try {
    const state = validatePhase4State(db, Date.now(), stateOptions);
    const audit = new AuditWriter(db);
    let closed = false;
    return {
      db,
      audit,
      state,
      close: () => {
        if (closed) return;
        closed = true;
        closeDatabase(db);
      },
    };
  } catch (cause) {
    closeDatabase(db);
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Phase 4 authority-state verification failed: ' +
        (cause instanceof Error ? cause.message : 'the authority state is invalid.'),
      'Inspect the authority state and retry. No automatic repair was performed.',
    );
  }
}

/** Opens a schema-valid Phase 4 database for local token administration. */
export function openPhase4ManagementRuntime(context: CommandContext): Phase4ManagementRuntime {
  return buildManagementRuntime(context, { requireUsableToken: false });
}

export function openPhase4Runtime(context: CommandContext): Phase4Runtime {
  const management = buildManagementRuntime(context, { requireUsableToken: true });
  try {
    const resolver = createPersistentTokenResolver(management.db, { audit: management.audit });
    return { ...management, resolver };
  } catch (cause) {
    management.close();
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Phase 4 persistent authentication setup failed.',
      cause instanceof Error ? cause.message : 'Inspect the authority state and retry.',
    );
  }
}

export function assertPhase4Ready(context: CommandContext): void {
  const runtime = openPhase4Runtime(context);
  runtime.close();
}
