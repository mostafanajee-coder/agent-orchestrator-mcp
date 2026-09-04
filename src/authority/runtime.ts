import { randomUUID } from 'node:crypto';

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
import { recoverOrphanedRuns } from '../domain/recovery.js';

import { AuditWriter, verifyAuditChain } from './audit.js';
import {
  AuthorizationStateManager,
  inspectAuthorizationState,
  type AuthorizationStateStatus,
} from './authorizationState.js';
import { validatePhase4State, type Phase4StateReport, type Phase4StateValidationOptions } from './state.js';
import {
  evaluateEdgeAdmission as evaluateEdgeAdmissionPolicy,
  type EdgeAdmissionDecision,
  type EdgeAdmissionFacts,
} from './policy.js';
import { isTrustedAuthorizationContext, type AuthorizationContext } from './context.js';

export interface Phase4ManagementRuntime {
  readonly db: SqliteDatabase;
  readonly audit: AuditWriter;
  readonly state: Phase4StateReport;
  /** External epoch/clock readiness; never a grant and never a startup gate. */
  readonly authorizationState: AuthorizationStateManager;
  readonly authorizationReadiness: AuthorizationStateStatus;
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

function recordAuthorizationReadinessIssue(
  audit: AuditWriter,
  status: AuthorizationStateStatus,
): void {
  const action = status.readiness === 'CLOCK_ROLLBACK'
    ? 'authorization.clock_rollback'
    : status.readiness === 'INVALID'
      ? 'authorization.state_invalid'
      : undefined;
  if (action === undefined) return;
  try {
    audit.append({
      actorId: 'system',
      actorRole: 'system',
      requestId: randomUUID(),
      action,
      subjectType: 'authorization_state',
      subjectId: 'authorization-state.v1.json',
      result: 'error',
      detail: { readiness: status.readiness },
      timestamp: new Date().toISOString(),
    });
  } catch {
    // A readiness diagnostic must never make direct serving fail. The
    // doctor/status surfaces still report the external-state condition.
  }
}

function openVerifiedDatabase(context: CommandContext): SqliteDatabase {
  assertDoctorPassed(runDoctor(context));
  const opened = openExistingDatabaseForServe(context);
  try {
    runMigrations(opened.db, { fresh: false });
    const integrity = verifyDatabaseIntegrity(opened.db);
    if (integrity.schemaVersion !== 9) {
      throw new SecurityError(
        'Phase 10B.4 requires the database to reach schema version 9 before serving.',
        'Run the approved Phase 10B.4 migration path and retry serve.',
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
    // This inspection is deliberately non-throwing. External authorization
    // state is a future delegated prerequisite, not a dependency of direct
    // observer or direct principal serving.
    const authorizationState = new AuthorizationStateManager({
      path: context.layout.authorizationStateFile,
      security: context.security,
      platform: context.platform,
    });
    const authorizationReadiness = inspectAuthorizationState({
      path: context.layout.authorizationStateFile,
      security: context.security,
      platform: context.platform,
    });
    recordAuthorizationReadinessIssue(audit, authorizationReadiness);
    let closed = false;
    return {
      db,
      audit,
      state,
      authorizationState,
      authorizationReadiness,
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
    recoverOrphanedRuns(management.db, management.audit);
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

interface EdgeBindingSqlRow {
  readonly edge_actor_id: unknown;
  readonly integration_id: unknown;
  readonly enabled: unknown;
  readonly current_integration_id: unknown;
  readonly integration_generation: unknown;
  readonly integration_enabled: unknown;
}

function edgeAdmissionFacts(
  runtime: Phase4ManagementRuntime,
  context: AuthorizationContext | undefined,
): EdgeAdmissionFacts {
  if (context?.transportRole !== 'edge') {
    return {
      readiness: runtime.authorizationReadiness.readiness,
      bindingExists: false,
      bindingEnabled: false,
      boundIntegrationId: null,
      integrationExists: false,
      integrationEnabled: false,
      currentIntegrationId: null,
      currentIntegrationGeneration: null,
    };
  }

  const bindingTable = runtime.db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'edge_transport_bindings'",
  ).get() as { readonly present?: unknown } | undefined;
  if (bindingTable?.present !== 1) {
    return {
      readiness: runtime.authorizationReadiness.readiness,
      bindingExists: false,
      bindingEnabled: false,
      boundIntegrationId: null,
      integrationExists: false,
      integrationEnabled: false,
      currentIntegrationId: null,
      currentIntegrationGeneration: null,
    };
  }

  const row = runtime.db.prepare(
    'SELECT b.edge_actor_id, b.integration_id, b.enabled, i.integration_id AS current_integration_id, i.generation AS integration_generation, i.enabled AS integration_enabled FROM edge_transport_bindings b LEFT JOIN integrations i ON i.integration_id = b.integration_id WHERE b.edge_actor_id = ?',
  ).get(context.transportActorId) as EdgeBindingSqlRow | undefined;
  return {
    readiness: runtime.authorizationReadiness.readiness,
    bindingExists: row !== undefined,
    bindingEnabled: row?.enabled === 1,
    boundIntegrationId: typeof row?.integration_id === 'string' ? row.integration_id : null,
    integrationExists: typeof row?.current_integration_id === 'string',
    integrationEnabled: row?.integration_enabled === 1,
    currentIntegrationId: typeof row?.current_integration_id === 'string'
      ? row.current_integration_id
      : null,
    currentIntegrationGeneration: Number.isSafeInteger(row?.integration_generation)
      ? row?.integration_generation as number
      : null,
  };
}

/** Evaluates and audits the internal deny-only edge admission boundary. */
export function evaluateEdgeAdmission(
  runtime: Phase4ManagementRuntime,
  context: AuthorizationContext | undefined,
  requestId: string = randomUUID(),
): EdgeAdmissionDecision {
  const decision = evaluateEdgeAdmissionPolicy(context, edgeAdmissionFacts(runtime, context));
  if (context === undefined
    || !isTrustedAuthorizationContext(context)
    || context.transportRole !== 'edge') {
    return decision;
  }
  try {
    runtime.audit.appendEdgeAdmissionDenied({
      actorId: context.transportActorId,
      sessionTokenId: context.provenance.sessionTokenId,
      integrationId: context.integrationId,
      requestId,
      reason: decision.reason,
    });
  } catch {
    return { allowed: false, reason: 'audit_failure' };
  }
  return decision;
}
