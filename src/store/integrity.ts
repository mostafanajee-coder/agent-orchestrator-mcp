import { SecurityError } from '../errors.js';
import {
  verifyPragmaPolicy,
  type SQLITE_PRAGMA_POLICY,
  type SqliteDatabase,
} from './db.js';
import {
  KNOWN_MIGRATION_VERSIONS,
  readMigrationLedger,
  validateAppliedPrefix,
} from './migrations.js';

export interface IntegrityReport {
  readonly schemaVersion: 2;
  readonly tableCount: 13;
  readonly triggerCount: 14;
  readonly appliedVersions: readonly number[];
  readonly pragmaPolicy: typeof SQLITE_PRAGMA_POLICY;
}

interface SchemaNameRow {
  readonly name: string;
}

interface ColumnRow {
  readonly name: string;
}

interface IndexInfoRow {
  readonly seqno: number;
  readonly name: string;
}

interface ForeignKeyRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

const EXPECTED_TABLES = [
  'schema_migrations',
  'actors',
  'actor_tokens',
  'decision_grants',
  'authoritative_statuses',
  'jobs',
  'decisions',
  'worker_runs',
  'evidence',
  'artifacts',
  'leases',
  'idempotency',
  'audit_log',
] as const;

const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_migrations: ['version', 'applied_at'],
  actors: ['actor_id', 'role', 'display_name', 'capabilities_json', 'disabled', 'created_at'],
  actor_tokens: [
    'token_id',
    'actor_id',
    'token_sha256',
    'label',
    'disabled',
    'expires_at',
    'last_used_at',
    'created_at',
  ],
  decision_grants: ['decision', 'authoritative_status'],
  authoritative_statuses: ['authoritative_status', 'rank', 'terminal'],
  jobs: [
    'job_id',
    'workspace',
    'title',
    'spec_json',
    'state',
    'state_reason',
    'authoritative_status',
    'deciding_decision_id',
    'owner_actor_id',
    'cycle',
    'max_cycles',
    'version',
    'deadline_at',
    'stale_after_s',
    'created_at',
    'updated_at',
  ],
  decisions: [
    'decision_id',
    'job_id',
    'cycle',
    'actor_id',
    'session_token_id',
    'request_id',
    'session_hint',
    'decision',
    'rationale',
    'evidence_refs',
    'from_state',
    'to_state',
    'created_at',
  ],
  worker_runs: [
    'run_id',
    'job_id',
    'cycle',
    'worker_id',
    'adapter',
    'request_json',
    'status',
    'worker_verdict',
    'failure_class',
    'exit_code',
    'pid',
    'usage_json',
    'stderr_tail',
    'attempt',
    'started_at',
    'ended_at',
    'created_at',
  ],
  evidence: [
    'evidence_id',
    'job_id',
    'cycle',
    'run_id',
    'source_actor',
    'trust',
    'kind',
    'severity',
    'summary',
    'detail_json',
    'artifact_id',
    'created_at',
  ],
  artifacts: [
    'artifact_id',
    'job_id',
    'cycle',
    'run_id',
    'kind',
    'mime',
    'label',
    'rel_path',
    'bytes',
    'sha256',
    'created_by',
    'created_at',
  ],
  leases: [
    'lease_id',
    'run_id',
    'job_id',
    'cycle',
    'actor_id',
    'nonce',
    'expires_at',
    'consumed_at',
    'created_at',
  ],
  idempotency: ['actor_id', 'key', 'request_hash', 'response_json', 'created_at'],
  audit_log: [
    'seq',
    'ts',
    'actor_id',
    'actor_role',
    'session_token_id',
    'request_id',
    'session_hint',
    'action',
    'job_id',
    'cycle',
    'capability',
    'subject_type',
    'subject_id',
    'from_state',
    'to_state',
    'from_auth_status',
    'to_auth_status',
    'result',
    'detail_json',
    'prev_hash',
    'hash',
  ],
};

const EXPECTED_INDEXES = [
  'ux_actors_single_principal',
  'ix_actor_tokens_actor',
  'ix_jobs_state_updated',
  'ix_jobs_workspace',
  'ix_jobs_auth_status',
  'ix_decisions_job',
  'ix_decisions_session',
  'ix_runs_job_cycle',
  'ux_worker_runs_run_job_cycle',
  'ix_evidence_job_cycle',
  'ux_artifacts_job_rel_path',
  'ux_leases_run_id',
  'ix_audit_job',
  'ix_audit_session',
] as const;

const EXPECTED_TRIGGERS = [
  'trg_decisions_principal_only',
  'trg_auth_status_requires_granting_decision',
  'trg_auth_status_monotonic',
  'trg_state_matches_auth_status',
  'trg_decisions_no_update',
  'trg_decisions_no_delete',
  'trg_audit_no_update',
  'trg_audit_no_delete',
  'trg_grants_frozen_i',
  'trg_grants_frozen_u',
  'trg_grants_frozen_d',
  'trg_auth_statuses_frozen_i',
  'trg_auth_statuses_frozen_u',
  'trg_auth_statuses_frozen_d',
] as const;

function fail(message: string, remedy = 'Restore the approved schema and retry.'): never {
  throw new SecurityError(message, remedy);
}

function equalNames(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function verifyTables(db: SqliteDatabase): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => (row as SchemaNameRow).name);
  if (!equalNames(tables, EXPECTED_TABLES)) {
    fail('The database does not contain exactly the approved 13-table schema.');
  }
}

function verifyColumns(db: SqliteDatabase): void {
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const columns = db.prepare("PRAGMA table_info('" + table + "')").all()
      .map((row) => (row as ColumnRow).name);
    if (!equalNames(columns, expected)) {
      fail('The ' + table + ' table has an unexpected column set.');
    }
  }
}

function verifyIndexes(db: SqliteDatabase): void {
  const indexes = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => (row as SchemaNameRow).name);
  if (EXPECTED_INDEXES.some((name) => !indexes.includes(name))) {
    fail('The database is missing one or more approved indexes.');
  }

  const partial = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'ux_actors_single_principal'",
  ).get() as { readonly sql?: string } | undefined;
  if (!partial?.sql?.toLowerCase().includes("where role = 'principal'")) {
    fail('The at-most-one-principal partial unique index is malformed.');
  }
}

function verifyTriggers(db: SqliteDatabase): void {
  const triggers = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger'",
  ).all().map((row) => (row as SchemaNameRow).name);
  if (!equalNames(triggers, EXPECTED_TRIGGERS)) {
    fail('The database does not contain exactly the approved T1–T6 trigger set.');
  }
}

function verifySeeds(db: SqliteDatabase): void {
  const grants = db.prepare(
    'SELECT decision, authoritative_status FROM decision_grants',
  ).all().map((row) => JSON.stringify(row)).sort();
  const expectedGrants = [
    { decision: 'APPROVE', authoritative_status: 'APPROVED' },
    { decision: 'CANCEL', authoritative_status: 'JOB_CANCELLED' },
    { decision: 'COMPLETE', authoritative_status: 'JOB_COMPLETED' },
    { decision: 'DELIVER', authoritative_status: 'READY_FOR_DELIVERY' },
    { decision: 'REJECT', authoritative_status: 'REJECTED' },
  ].map((row) => JSON.stringify(row)).sort();
  if (!equalNames(grants, expectedGrants)) {
    fail('The decision_grants seed set is not exact.');
  }

  const statuses = db.prepare(
    'SELECT authoritative_status, rank, terminal FROM authoritative_statuses',
  ).all().map((row) => JSON.stringify(row)).sort();
  const expectedStatuses = [
    { authoritative_status: 'APPROVED', rank: 10, terminal: 0 },
    { authoritative_status: 'READY_FOR_DELIVERY', rank: 20, terminal: 0 },
    { authoritative_status: 'JOB_COMPLETED', rank: 30, terminal: 1 },
    { authoritative_status: 'REJECTED', rank: 90, terminal: 1 },
    { authoritative_status: 'JOB_CANCELLED', rank: 91, terminal: 1 },
  ].map((row) => JSON.stringify(row)).sort();
  if (!equalNames(statuses, expectedStatuses)) {
    fail('The authoritative_statuses seed set is not exact.');
  }
}

function verifyLeaseRelation(db: SqliteDatabase): void {
  const uniqueColumns = db.prepare(
    "PRAGMA index_info('ux_worker_runs_run_job_cycle')",
  ).all() as IndexInfoRow[];
  const orderedColumns = uniqueColumns.sort((left, right) => left.seqno - right.seqno).map((row) => row.name);
  if (!equalNames(orderedColumns, ['run_id', 'job_id', 'cycle'])) {
    fail('The worker_runs composite lease-parent uniqueness is missing or malformed.');
  }

  const foreignKeys = db.pragma('foreign_key_list(leases)') as ForeignKeyRow[];
  const grouped = new Map<number, ForeignKeyRow[]>();
  for (const row of foreignKeys) {
    const group = grouped.get(row.id) ?? [];
    group.push(row);
    grouped.set(row.id, group);
  }
  const hasComposite = [...grouped.values()].some((rows) => {
    const ordered = [...rows].sort((left, right) => left.seq - right.seq);
    return ordered.length === 3
      && ordered.every((row) => row.table === 'worker_runs')
      && equalNames(ordered.map((row) => row.from), ['run_id', 'job_id', 'cycle'])
      && equalNames(ordered.map((row) => row.to), ['run_id', 'job_id', 'cycle']);
  });
  if (!hasComposite) {
    fail('The leases composite run/job/cycle foreign key is missing or malformed.');
  }
}

function verifySqlHealth(db: SqliteDatabase): void {
  const quickCheck = db.pragma('quick_check', { simple: true });
  if (String(quickCheck).toLowerCase() !== 'ok') {
    fail('SQLite quick_check did not return ok.');
  }
  if ((db.pragma('foreign_key_check') as readonly unknown[]).length !== 0) {
    fail('SQLite foreign_key_check reported a violation.');
  }
}

export function verifyDatabaseIntegrity(db: SqliteDatabase): IntegrityReport {
  try {
    const policy = verifyPragmaPolicy(db);
    const ledger = readMigrationLedger(db);
    validateAppliedPrefix(ledger, false, KNOWN_MIGRATION_VERSIONS);
    if (
      ledger.versions.length !== KNOWN_MIGRATION_VERSIONS.length ||
      ledger.versions.some((version, index) => version !== KNOWN_MIGRATION_VERSIONS[index])
    ) {
      fail('The database is not at the current Phase 3 schema version.');
    }
    verifySqlHealth(db);
    verifyTables(db);
    verifyColumns(db);
    verifyIndexes(db);
    verifyTriggers(db);
    verifySeeds(db);
    verifyLeaseRelation(db);
    return {
      schemaVersion: 2,
      tableCount: EXPECTED_TABLES.length,
      triggerCount: EXPECTED_TRIGGERS.length,
      appliedVersions: ledger.versions,
      pragmaPolicy: policy,
    };
  } catch (cause) {
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Phase 3 database integrity verification failed.',
      cause instanceof Error ? cause.message : 'Inspect the database and retry.',
    );
  }
}
