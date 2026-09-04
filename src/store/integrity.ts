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
import {
  canonicalSchemaDefinitionsForVersion,
  fingerprintSchemaSql,
  type CanonicalSchemaVersion,
} from './schemaDefinitions.js';

export interface IntegrityReport {
  readonly schemaVersion: CanonicalSchemaVersion;
  readonly tableCount: number;
  readonly triggerCount: number;
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

export const EXPECTED_TABLES = [
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

export const EXPECTED_TABLES_BY_VERSION = {
  4: EXPECTED_TABLES,
  5: EXPECTED_TABLES,
  6: EXPECTED_TABLES,
  7: EXPECTED_TABLES,
  8: [...EXPECTED_TABLES, 'integrations'],
  9: [...EXPECTED_TABLES, 'integrations', 'edge_transport_bindings'],
} as const satisfies Readonly<Record<CanonicalSchemaVersion, readonly string[]>>;

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

const EXPECTED_COLUMNS_BY_VERSION = {
  4: EXPECTED_COLUMNS,
  5: EXPECTED_COLUMNS,
  6: EXPECTED_COLUMNS,
  7: EXPECTED_COLUMNS,
  8: {
    ...EXPECTED_COLUMNS,
    integrations: ['integration_id', 'generation', 'enabled', 'created_at', 'updated_at'],
  },
  9: {
    ...EXPECTED_COLUMNS,
    integrations: ['integration_id', 'generation', 'enabled', 'created_at', 'updated_at'],
    edge_transport_bindings: [
      'edge_actor_id',
      'integration_id',
      'enabled',
      'created_at',
      'updated_at',
    ],
  },
} as const satisfies Readonly<Record<CanonicalSchemaVersion, Readonly<Record<string, readonly string[]>>>>;

export const EXPECTED_INDEXES = [
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

export const EXPECTED_INDEXES_BY_VERSION = {
  4: EXPECTED_INDEXES,
  5: EXPECTED_INDEXES,
  6: EXPECTED_INDEXES,
  7: [
    ...EXPECTED_INDEXES,
    'ix_evidence_job_cycle_created',
    'ix_artifacts_job_cycle_created',
  ],
  8: [
    ...EXPECTED_INDEXES,
    'ix_evidence_job_cycle_created',
    'ix_artifacts_job_cycle_created',
  ],
  9: [
    ...EXPECTED_INDEXES,
    'ix_evidence_job_cycle_created',
    'ix_artifacts_job_cycle_created',
    'ux_edge_transport_bindings_integration',
  ],
} as const satisfies Readonly<Record<CanonicalSchemaVersion, readonly string[]>>;

export const EXPECTED_TRIGGERS = [
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
  'trg_jobs_unstamped_on_insert',
  'trg_jobs_no_delete',
  'trg_jobs_no_replace',
  'trg_decisions_no_replace',
  'trg_audit_no_replace',
] as const;

export const EXPECTED_TRIGGERS_BY_VERSION = {
  4: EXPECTED_TRIGGERS,
  5: EXPECTED_TRIGGERS,
  6: [
    ...EXPECTED_TRIGGERS,
    'trg_actors_identity_immutable',
    'trg_actor_tokens_binding_immutable',
    'trg_actor_tokens_no_reenable',
  ],
  7: [
    ...EXPECTED_TRIGGERS,
    'trg_actors_identity_immutable',
    'trg_actor_tokens_binding_immutable',
    'trg_actor_tokens_no_reenable',
    'trg_evidence_no_update',
    'trg_evidence_no_delete',
    'trg_evidence_no_replace',
    'trg_evidence_binding',
    'trg_artifacts_no_update',
    'trg_artifacts_no_delete',
    'trg_artifacts_no_replace',
    'trg_artifacts_binding',
  ],
  8: [
    ...EXPECTED_TRIGGERS,
    'trg_actors_identity_immutable',
    'trg_actor_tokens_binding_immutable',
    'trg_actor_tokens_no_reenable',
    'trg_evidence_no_update',
    'trg_evidence_no_delete',
    'trg_evidence_no_replace',
    'trg_evidence_binding',
    'trg_artifacts_no_update',
    'trg_artifacts_no_delete',
    'trg_artifacts_no_replace',
    'trg_artifacts_binding',
    'trg_integrations_no_replace',
    'trg_integrations_identity_immutable',
    'trg_integrations_generation_monotonic',
  ],
  9: [
    ...EXPECTED_TRIGGERS,
    'trg_actors_identity_immutable',
    'trg_actor_tokens_binding_immutable',
    'trg_actor_tokens_no_reenable',
    'trg_evidence_no_update',
    'trg_evidence_no_delete',
    'trg_evidence_no_replace',
    'trg_evidence_binding',
    'trg_artifacts_no_update',
    'trg_artifacts_no_delete',
    'trg_artifacts_no_replace',
    'trg_artifacts_binding',
    'trg_integrations_no_replace',
    'trg_integrations_identity_immutable',
    'trg_integrations_generation_monotonic',
    'trg_edge_bindings_no_replace',
    'trg_edge_bindings_identity_immutable',
    'trg_edge_bindings_no_delete',
    'trg_edge_bindings_actor_role',
  ],
} as const satisfies Readonly<Record<CanonicalSchemaVersion, readonly string[]>>;

function fail(message: string, remedy = 'Restore the approved schema and retry.'): never {
  throw new SecurityError(message, remedy);
}

function equalNames(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function verifyCanonicalDefinitions(
  db: SqliteDatabase,
  type: 'table' | 'index' | 'trigger',
  definitions: Readonly<Record<string, string>>,
): void {
  for (const [name, expectedFingerprint] of Object.entries(definitions)) {
    const row = db.prepare(
      'SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?',
    ).get(type, name) as { readonly sql?: unknown } | undefined;
    if (typeof row?.sql !== 'string' || fingerprintSchemaSql(row.sql) !== expectedFingerprint) {
      fail(
        'The approved ' + type + ' definition for ' + name + ' does not match the canonical definition.',
        'Restore the exact approved schema before serving.',
      );
    }
  }
}

function verifyTables(db: SqliteDatabase, version: CanonicalSchemaVersion): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => (row as SchemaNameRow).name);
  const expectedTables = EXPECTED_TABLES_BY_VERSION[version];
  if (!equalNames(tables, expectedTables)) {
    fail('The database does not contain exactly the approved ' + String(expectedTables.length) + '-table schema.');
  }
  verifyCanonicalDefinitions(
    db,
    'table',
    canonicalSchemaDefinitionsForVersion(version)?.tables ?? {},
  );
}

function verifyColumns(db: SqliteDatabase, version: CanonicalSchemaVersion): void {
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS_BY_VERSION[version])) {
    const columns = db.prepare("PRAGMA table_info('" + table + "')").all()
      .map((row) => (row as ColumnRow).name);
    if (!equalNames(columns, expected)) {
      fail('The ' + table + ' table has an unexpected column set.');
    }
  }
}

function verifyIndexes(db: SqliteDatabase, version: CanonicalSchemaVersion): void {
  const indexes = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => (row as SchemaNameRow).name);
  if (!equalNames(indexes, EXPECTED_INDEXES_BY_VERSION[version])) {
    fail('The database does not contain exactly the approved named index set.');
  }
  verifyCanonicalDefinitions(
    db,
    'index',
    canonicalSchemaDefinitionsForVersion(version)?.indexes ?? {},
  );

  const partial = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'ux_actors_single_principal'",
  ).get() as { readonly sql?: string } | undefined;
  if (!partial?.sql?.toLowerCase().includes("where role = 'principal'")) {
    fail('The at-most-one-principal partial unique index is malformed.');
  }

  const uniqueIndexChecks = [
    ['actors', 'ux_actors_single_principal', true, true],
    ['worker_runs', 'ux_worker_runs_run_job_cycle', true, false],
    ['leases', 'ux_leases_run_id', true, false],
    ['artifacts', 'ux_artifacts_job_rel_path', true, false],
  ] as const;
  for (const [table, indexName, unique, partial] of uniqueIndexChecks) {
    const row = (db.pragma("index_list('" + table + "')") as Array<{
      readonly name: string;
      readonly unique: number;
      readonly partial: number;
    }>).find((entry) => entry.name === indexName);
    if (row?.unique !== (unique ? 1 : 0) || row.partial !== (partial ? 1 : 0)) {
      fail('The security-sensitive index ' + indexName + ' is not uniquely defined as approved.');
    }
  }
  if (version >= 9) {
    const edgeIndex = (db.pragma("index_list('edge_transport_bindings')") as Array<{
      readonly name: string;
      readonly unique: number;
      readonly partial: number;
    }>).find((entry) => entry.name === 'ux_edge_transport_bindings_integration');
    if (edgeIndex?.unique !== 1 || edgeIndex.partial !== 0) {
      fail('The edge transport integration binding index is not uniquely defined as approved.');
    }
  }
}

function verifyTriggers(db: SqliteDatabase, version: CanonicalSchemaVersion): void {
  const triggers = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger'",
  ).all().map((row) => (row as SchemaNameRow).name);
  const expected = EXPECTED_TRIGGERS_BY_VERSION[version];
  if (!equalNames(triggers, expected)) {
    fail('The database does not contain exactly the approved trigger set for schema version ' + String(version) + '.');
  }
  verifyCanonicalDefinitions(
    db,
    'trigger',
    canonicalSchemaDefinitionsForVersion(version)?.triggers ?? {},
  );
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

interface EdgeBindingRow {
  readonly edge_actor_id: unknown;
  readonly integration_id: unknown;
  readonly enabled: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

function verifyEdgeBindings(db: SqliteDatabase, version: CanonicalSchemaVersion): void {
  if (version < 9) return;

  const edgeActors = db.prepare(
    "SELECT actor_id FROM actors WHERE role = 'edge' ORDER BY actor_id",
  ).all() as Array<{ readonly actor_id: unknown }>;
  const bindings = db.prepare(
    'SELECT edge_actor_id, integration_id, enabled, created_at, updated_at FROM edge_transport_bindings ORDER BY edge_actor_id',
  ).all() as EdgeBindingRow[];
  const boundActors = new Set<string>();
  for (const binding of bindings) {
    if (
      typeof binding.edge_actor_id !== 'string'
      || binding.edge_actor_id.trim() === ''
      || typeof binding.integration_id !== 'string'
      || binding.integration_id.trim() === ''
      || (binding.enabled !== 0 && binding.enabled !== 1)
      || typeof binding.created_at !== 'string'
      || binding.created_at.trim() === ''
      || typeof binding.updated_at !== 'string'
      || binding.updated_at.trim() === ''
    ) {
      fail('The edge transport binding contains malformed fields.');
    }
    if (boundActors.has(binding.edge_actor_id)) {
      fail('The edge transport binding contains a duplicate actor identity.');
    }
    boundActors.add(binding.edge_actor_id);
    const actor = db.prepare(
      'SELECT role FROM actors WHERE actor_id = ?',
    ).get(binding.edge_actor_id) as { readonly role?: unknown } | undefined;
    if (actor?.role !== 'edge') {
      fail('Every edge transport binding must reference an edge actor.');
    }
    const integration = db.prepare(
      'SELECT integration_id FROM integrations WHERE integration_id = ?',
    ).get(binding.integration_id) as { readonly integration_id?: unknown } | undefined;
    if (integration?.integration_id !== binding.integration_id) {
      fail('Every edge transport binding must reference an existing integration.');
    }
  }

  const edgeActorIds = edgeActors.map((row) => row.actor_id);
  if (
    edgeActorIds.some((actorId) => typeof actorId !== 'string' || !boundActors.has(actorId))
    || boundActors.size !== edgeActorIds.length
  ) {
    fail('Every edge actor must have exactly one edge transport binding.');
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
    const schemaVersion = ledger.versions[ledger.versions.length - 1];
    if (schemaVersion !== 4 && schemaVersion !== 5 && schemaVersion !== 6 && schemaVersion !== 7 && schemaVersion !== 8 && schemaVersion !== 9) {
      fail('The database has an unsupported schema version.');
    }
    verifyTables(db, schemaVersion);
    verifyColumns(db, schemaVersion);
    verifyIndexes(db, schemaVersion);
    verifyTriggers(db, schemaVersion);
    verifySqlHealth(db);
    verifySeeds(db);
    verifyLeaseRelation(db);
    verifyEdgeBindings(db, schemaVersion);
    return {
      schemaVersion,
      tableCount: EXPECTED_TABLES_BY_VERSION[schemaVersion].length,
      triggerCount: EXPECTED_TRIGGERS_BY_VERSION[schemaVersion].length,
      appliedVersions: ledger.versions,
      pragmaPolicy: policy,
    };
  } catch (cause) {
    if (cause instanceof SecurityError) throw cause;
    throw new SecurityError(
      'Database integrity verification failed.',
      cause instanceof Error ? cause.message : 'Inspect the database and retry.',
    );
  }
}
