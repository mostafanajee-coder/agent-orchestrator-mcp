import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod/v4';

import {
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  hasCapability,
  type Capability,
} from '../authority/capabilities.js';
import type { AuditWriter } from '../authority/audit.js';
import type { VerifiedActorAuthInfo } from '../mcp/auth.js';
import type { SqliteDatabase } from '../store/db.js';
import { withImmediateTransaction } from '../store/db.js';
import { redactSensitiveDetail, redactSensitiveText } from '../security/redaction.js';
import {
  requireActiveWorkerLease,
  type ActiveWorkerLease,
  type WorkerLeaseOptions,
} from './workerLease.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_KIND_BYTES = 64;
const MAX_SUMMARY_BYTES = 2_048;
const MAX_DETAIL_BYTES = 65_536;
const MAX_EVIDENCE_ROWS_PER_JOB = 1_024;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_BYTES = 2_048;
const SEVERITY_VALUES = ['info', 'warning', 'error', 'critical'] as const;

export const EvidenceAddInputSchema = z.object({
  job_id: z.string().trim().min(1).max(MAX_IDENTIFIER_BYTES),
  cycle: z.number().int().nonnegative(),
  run_id: z.string().trim().min(1).max(MAX_IDENTIFIER_BYTES).optional(),
  kind: z.string().trim().min(1).max(MAX_KIND_BYTES),
  severity: z.enum(SEVERITY_VALUES).nullable().optional(),
  summary: z.string().trim().min(1).max(MAX_SUMMARY_BYTES),
  detail: z.unknown().optional(),
  artifact_id: z.string().trim().min(1).max(MAX_IDENTIFIER_BYTES).optional(),
  lease: z.string().trim().min(1).max(16_384).optional(),
  idempotency_key: z.string().regex(UUID_PATTERN),
}).strict();

export const EvidenceListInputSchema = z.object({
  job_id: z.string().trim().min(1).max(MAX_IDENTIFIER_BYTES),
  cycle: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().trim().min(1).max(MAX_CURSOR_BYTES).optional(),
}).strict();

export interface EvidenceRecord {
  readonly evidence_id: string;
  readonly job_id: string;
  readonly cycle: number;
  readonly run_id: string | null;
  readonly source_actor: string;
  readonly trust: 'deterministic' | 'untrusted' | 'principal';
  readonly kind: string;
  readonly severity: (typeof SEVERITY_VALUES)[number] | null;
  readonly summary: string;
  readonly detail: unknown | null;
  readonly artifact_id: string | null;
  readonly created_at: string;
}

export interface EvidenceListResult {
  readonly evidence: readonly EvidenceRecord[];
  readonly next_cursor?: string;
}

export type EvidenceAddInput = z.infer<typeof EvidenceAddInputSchema>;
export type EvidenceListInput = z.infer<typeof EvidenceListInputSchema>;

export type EvidenceErrorCode =
  | 'INVALID_INPUT'
  | 'AUTHORIZATION_DENIED'
  | 'JOB_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'ARTIFACT_NOT_FOUND'
  | 'LEASE_INVALID'
  | 'STALE_CYCLE'
  | 'STATE_CONFLICT'
  | 'LIMIT_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL_ERROR';

export const EVIDENCE_ERROR_CODES = [
  'INVALID_INPUT',
  'AUTHORIZATION_DENIED',
  'JOB_NOT_FOUND',
  'RUN_NOT_FOUND',
  'ARTIFACT_NOT_FOUND',
  'LEASE_INVALID',
  'STALE_CYCLE',
  'STATE_CONFLICT',
  'LIMIT_EXCEEDED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
] as const satisfies readonly EvidenceErrorCode[];

export class EvidenceError extends Error {
  public override readonly name = 'EvidenceError';

  public constructor(
    public readonly code: EvidenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface EvidenceSqlRow {
  readonly evidence_id: unknown;
  readonly job_id: unknown;
  readonly cycle: unknown;
  readonly run_id: unknown;
  readonly source_actor: unknown;
  readonly trust: unknown;
  readonly kind: unknown;
  readonly severity: unknown;
  readonly summary: unknown;
  readonly detail_json: unknown;
  readonly artifact_id: unknown;
  readonly created_at: unknown;
}

interface IdempotencyRow {
  readonly request_hash: unknown;
  readonly response_json: unknown;
}

interface Cursor {
  readonly version: 1;
  readonly job_id: string;
  readonly cycle: number | null;
  readonly created_at: string;
  readonly evidence_id: string;
}

interface AdmissionContext {
  readonly actorId: string;
  readonly actorRole: 'principal' | 'worker';
  readonly capabilities: readonly Capability[];
  readonly sessionTokenId: string | null;
  readonly sessionHint: string | null;
  readonly trust: EvidenceRecord['trust'];
  readonly lease?: ActiveWorkerLease;
}

function fail(code: EvidenceErrorCode, message: string): never {
  throw new EvidenceError(code, message);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function secretValues(lease: string | undefined): readonly string[] {
  return lease === undefined ? [] : [lease];
}

function safeText(value: string, lease: string | undefined): string {
  return redactSensitiveText(value, secretValues(lease), { redactAbsolutePaths: true });
}

function safeDetail(value: unknown, lease: string | undefined): unknown {
  return redactSensitiveDetail(value, secretValues(lease), { redactAbsolutePaths: true });
}

function nowIso(options: WorkerLeaseOptions): string {
  return new Date((options.clock ?? (() => Date.now()))()).toISOString();
}

function detailJson(value: unknown): string | null {
  if (value === undefined) return null;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('INVALID_INPUT', 'Evidence detail must be JSON serializable.');
  }
  if (serialized === undefined || byteLength(serialized) > MAX_DETAIL_BYTES) {
    fail('INVALID_INPUT', 'Evidence detail exceeds its byte bound.');
  }
  return serialized;
}

function parseInput(raw: unknown): { readonly input: EvidenceAddInput; readonly detail: string | null } {
  const parsed = EvidenceAddInputSchema.safeParse(raw);
  if (!parsed.success) fail('INVALID_INPUT', 'The evidence input is invalid.');
  const lease = parsed.data.lease;
  const input: EvidenceAddInput = {
    ...parsed.data,
    kind: safeText(parsed.data.kind, lease),
    summary: safeText(parsed.data.summary, lease),
    ...(parsed.data.detail === undefined ? {} : { detail: safeDetail(parsed.data.detail, lease) }),
  };
  if (byteLength(input.job_id) > MAX_IDENTIFIER_BYTES
    || byteLength(input.run_id ?? '') > MAX_IDENTIFIER_BYTES
    || byteLength(input.kind) > MAX_KIND_BYTES
    || byteLength(input.summary) > MAX_SUMMARY_BYTES) {
    fail('INVALID_INPUT', 'An evidence field exceeds its byte bound.');
  }
  return { input, detail: detailJson(input.detail) };
}

function validActor(actor: VerifiedActorAuthInfo): boolean {
  try {
    assertRoleCapabilities(actor.role, actor.capabilities);
    return actor.clientId === actor.actorId
      && canonicalCapabilitiesJson(actor.capabilities) === JSON.stringify(actor.capabilities);
  } catch {
    return false;
  }
}

function actorContext(
  actor: VerifiedActorAuthInfo,
  input: EvidenceAddInput,
  options: WorkerLeaseOptions,
  db: SqliteDatabase,
): AdmissionContext {
  if (!validActor(actor) || !hasCapability(actor.capabilities, 'evidence:add')) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot add evidence.');
  }
  if (actor.role === 'principal') {
    if (actor.actorId !== 'codex' || input.lease !== undefined) {
      fail('AUTHORIZATION_DENIED', 'The principal evidence binding is invalid.');
    }
    return {
      actorId: actor.actorId,
      actorRole: 'principal',
      capabilities: actor.capabilities,
      sessionTokenId: actor.tokenId,
      sessionHint: actor.sessionLabel,
      trust: 'principal',
    };
  }
  if (actor.role !== 'worker' || input.lease === undefined || input.run_id === undefined) {
    fail('AUTHORIZATION_DENIED', 'A worker must provide an active run lease.');
  }
  let lease: ActiveWorkerLease;
  try {
    lease = requireActiveWorkerLease(db, input.lease, actor.actorId, options);
  } catch (cause) {
    fail('LEASE_INVALID', cause instanceof Error ? cause.message : 'The worker lease is invalid.');
  }
  if (!hasCapability(lease.capabilities, 'evidence:add') || input.run_id !== lease.payload.run_id) {
    fail('AUTHORIZATION_DENIED', 'The worker is not authorized for this evidence binding.');
  }
  return {
    actorId: actor.actorId,
    actorRole: 'worker',
    capabilities: lease.capabilities,
    sessionTokenId: actor.tokenId,
    sessionHint: actor.sessionLabel,
    trust: 'untrusted',
    lease,
  };
}

function runtimeContext(lease: ActiveWorkerLease): AdmissionContext {
  if (!hasCapability(lease.capabilities, 'evidence:add')) {
    fail('AUTHORIZATION_DENIED', 'The worker is not authorized to add evidence.');
  }
  return {
    actorId: lease.actorId,
    actorRole: 'worker',
    capabilities: lease.capabilities,
    sessionTokenId: null,
    sessionHint: null,
    trust: 'untrusted',
    lease,
  };
}

function requestHash(input: EvidenceAddInput, detail: string | null): string {
  return createHash('sha256').update(JSON.stringify({
    operation: 'evidence_add',
    job_id: input.job_id,
    cycle: input.cycle,
    run_id: input.run_id ?? null,
    kind: input.kind,
    severity: input.severity ?? null,
    summary: input.summary,
    detail,
    artifact_id: input.artifact_id ?? null,
    lease: input.lease ?? null,
  }), 'utf8').digest('hex');
}

function readIdempotency(
  db: SqliteDatabase,
  actorId: string,
  key: string,
  hash: string,
  lease: string | undefined,
): EvidenceRecord | undefined {
  const row = db.prepare(
    'SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND key = ?',
  ).get(actorId, key) as IdempotencyRow | undefined;
  if (row === undefined) return undefined;
  if (row.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was used for different evidence.');
  try {
    const parsed: unknown = JSON.parse(String(row.response_json));
    const result = EvidenceRecordSchema.safeParse(parsed);
    if (!result.success) fail('INTERNAL_ERROR', 'The stored evidence idempotency response is invalid.');
    return {
      ...result.data,
      kind: safeText(result.data.kind, lease),
      summary: safeText(result.data.summary, lease),
      detail: result.data.detail === null ? null : safeDetail(result.data.detail, lease),
    };
  } catch (cause) {
    if (cause instanceof EvidenceError) throw cause;
    fail('INTERNAL_ERROR', 'The stored evidence idempotency response is invalid.');
  }
}

export const EvidenceRecordSchema = z.object({
  evidence_id: z.string(),
  job_id: z.string(),
  cycle: z.number().int().nonnegative(),
  run_id: z.string().nullable(),
  source_actor: z.string(),
  trust: z.enum(['deterministic', 'untrusted', 'principal']),
  kind: z.string(),
  severity: z.enum(SEVERITY_VALUES).nullable(),
  summary: z.string(),
  detail: z.unknown().nullable(),
  artifact_id: z.string().nullable(),
  created_at: z.string(),
});

function parseStored(row: EvidenceSqlRow): EvidenceRecord {
  let detail: unknown | null = null;
  if (row.detail_json !== null && row.detail_json !== undefined) {
    try {
      detail = safeDetail(JSON.parse(String(row.detail_json)), undefined);
    } catch {
      fail('INTERNAL_ERROR', 'An evidence detail record is not valid JSON.');
    }
  }
  const result: EvidenceRecord = {
    evidence_id: String(row.evidence_id),
    job_id: String(row.job_id),
    cycle: Number(row.cycle),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    source_actor: String(row.source_actor),
    trust: row.trust as EvidenceRecord['trust'],
    kind: safeText(String(row.kind), undefined),
    severity: row.severity === null || row.severity === undefined
      ? null
      : row.severity as EvidenceRecord['severity'],
    summary: safeText(String(row.summary), undefined),
    detail,
    artifact_id: row.artifact_id === null || row.artifact_id === undefined ? null : String(row.artifact_id),
    created_at: String(row.created_at),
  };
  if (!EvidenceRecordSchema.safeParse(result).success) {
    fail('INTERNAL_ERROR', 'An evidence row has an invalid stored shape.');
  }
  return result;
}

function loadJob(db: SqliteDatabase, jobId: string): { readonly job_id: string; readonly cycle: number } {
  const row = db.prepare('SELECT job_id, cycle FROM jobs WHERE job_id = ?').get(jobId) as Record<string, unknown> | undefined;
  if (row === undefined) fail('JOB_NOT_FOUND', 'The requested job was not found.');
  return { job_id: String(row['job_id']), cycle: Number(row['cycle']) };
}

function assertLeaseInsideTransaction(
  db: SqliteDatabase,
  context: AdmissionContext,
  input: EvidenceAddInput,
  options: WorkerLeaseOptions,
): void {
  if (context.lease === undefined) return;
  const row = db.prepare(
    `SELECT l.consumed_at, l.expires_at, wr.status AS run_status, j.state AS job_state
       FROM leases l
       JOIN worker_runs wr ON wr.run_id = l.run_id
       JOIN jobs j ON j.job_id = l.job_id
      WHERE l.lease_id = ? AND l.run_id = ? AND l.job_id = ? AND l.cycle = ? AND l.actor_id = ?`,
  ).get(
    context.lease.payload.lease_id,
    context.lease.payload.run_id,
    input.job_id,
    input.cycle,
    context.actorId,
  ) as Record<string, unknown> | undefined;
  if (row === undefined || row['consumed_at'] !== null
    || (options.allowExpired !== true && Date.parse(String(row['expires_at'])) <= (options.clock ?? (() => Date.now()))())
    || String(row['job_state']) !== 'QA_RUNNING'
    || (String(row['run_status']) !== 'PENDING' && String(row['run_status']) !== 'RUNNING')) {
    fail('LEASE_INVALID', 'The worker lease is no longer active.');
  }
}

function assertInputBindings(
  db: SqliteDatabase,
  input: EvidenceAddInput,
  context: AdmissionContext,
): void {
  const job = loadJob(db, input.job_id);
  if (job.cycle !== input.cycle) fail('STALE_CYCLE', 'The evidence cycle does not match the current job cycle.');
  if (context.lease !== undefined && input.run_id !== context.lease.payload.run_id) {
    fail('LEASE_INVALID', 'The worker lease does not match the evidence run.');
  }
  if (input.run_id !== undefined) {
    const run = db.prepare(
      'SELECT 1 AS present FROM worker_runs WHERE run_id = ? AND job_id = ? AND cycle = ?',
    ).get(input.run_id, input.job_id, input.cycle) as { readonly present?: number } | undefined;
    if (run?.present !== 1) fail('RUN_NOT_FOUND', 'The evidence run was not found for this job cycle.');
  }
  if (input.artifact_id !== undefined) {
    const artifact = db.prepare(
      `SELECT 1 AS present FROM artifacts
        WHERE artifact_id = ? AND job_id = ? AND cycle = ?
          AND (? IS NULL OR run_id = ?)`,
    ).get(input.artifact_id, input.job_id, input.cycle, input.run_id ?? null, input.run_id ?? null) as { readonly present?: number } | undefined;
    if (artifact?.present !== 1) fail('ARTIFACT_NOT_FOUND', 'The evidence artifact reference is not compatible with this job cycle.');
  }
  const count = db.prepare(
    'SELECT count(*) AS count FROM evidence WHERE job_id = ?',
  ).get(input.job_id) as { readonly count?: unknown };
  if (Number(count.count) >= MAX_EVIDENCE_ROWS_PER_JOB) {
    fail('LIMIT_EXCEEDED', 'The evidence limit for this job has been reached.');
  }
}

function insertEvidenceInTransaction(
  db: SqliteDatabase,
  audit: AuditWriter,
  input: EvidenceAddInput,
  detail: string | null,
  context: AdmissionContext,
  requestId: string,
  options: WorkerLeaseOptions,
): EvidenceRecord {
  assertLeaseInsideTransaction(db, context, input, options);
  assertInputBindings(db, input, context);
  const createdAt = nowIso(options);
  const evidenceId = randomUUID();
  db.prepare(
    `INSERT INTO evidence(evidence_id, job_id, cycle, run_id, source_actor, trust, kind, severity, summary, detail_json, artifact_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evidenceId,
    input.job_id,
    input.cycle,
    input.run_id ?? null,
    context.actorId,
    context.trust,
    input.kind,
    input.severity ?? null,
    input.summary,
    detail,
    input.artifact_id ?? null,
    createdAt,
  );
  audit.appendInTransaction({
    actorId: context.actorId,
    actorRole: context.actorRole,
    sessionTokenId: context.sessionTokenId,
    requestId,
    sessionHint: context.sessionHint,
    action: 'evidence.add',
    jobId: input.job_id,
    cycle: input.cycle,
    capability: 'evidence:add',
    subjectType: 'evidence',
    subjectId: evidenceId,
    result: 'ok',
    detail: {
      kind: input.kind,
      trust: context.trust,
      ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
    },
    secretValues: secretValues(input.lease),
    timestamp: createdAt,
  });
  const row = db.prepare(
    `SELECT evidence_id, job_id, cycle, run_id, source_actor, trust, kind, severity, summary, detail_json, artifact_id, created_at
       FROM evidence WHERE evidence_id = ?`,
  ).get(evidenceId) as EvidenceSqlRow;
  return parseStored(row);
}

export function addEvidence(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  rawInput: unknown,
  requestId: string,
  options: WorkerLeaseOptions,
): EvidenceRecord {
  const { input, detail } = parseInput(rawInput);
  const context = actorContext(actor, input, options, db);
  const hash = requestHash(input, detail);
  try {
    return withImmediateTransaction(db, () => {
      const replay = readIdempotency(db, actor.actorId, input.idempotency_key, hash, input.lease);
      if (replay !== undefined) return replay;
      const record = insertEvidenceInTransaction(db, audit, input, detail, context, requestId, options);
      db.prepare(
        'INSERT INTO idempotency(actor_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(actor.actorId, input.idempotency_key, hash, JSON.stringify(record), record.created_at);
      return record;
    });
  } catch (cause) {
    if (cause instanceof EvidenceError) {
      try {
        audit.append({
          actorId: context.actorId,
          actorRole: context.actorRole,
          sessionTokenId: context.sessionTokenId,
          requestId,
          sessionHint: context.sessionHint,
          action: 'evidence.rejected',
          jobId: input.job_id,
          cycle: input.cycle,
          capability: 'evidence:add',
          subjectType: 'evidence',
          result: 'denied',
          detail: { code: cause.code },
          secretValues: secretValues(input.lease),
        });
      } catch {
        // A rejected request must not hide its original typed error.
      }
    }
    throw cause;
  }
}

export function addRuntimeEvidence(
  db: SqliteDatabase,
  audit: AuditWriter,
  lease: string,
  input: Omit<EvidenceAddInput, 'idempotency_key' | 'lease' | 'job_id' | 'cycle' | 'run_id'> & {
    readonly job_id: string;
    readonly cycle: number;
    readonly run_id: string;
    readonly artifact_id?: string;
  },
  requestId: string,
  options: WorkerLeaseOptions,
): EvidenceRecord {
  const parsed = parseInput({
    ...input,
    idempotency_key: randomUUID(),
    lease,
  });
  let active: ActiveWorkerLease;
  try {
    active = requireActiveWorkerLease(db, lease, undefined, options);
  } catch (cause) {
    fail('LEASE_INVALID', cause instanceof Error ? cause.message : 'The worker lease is invalid.');
  }
  if (active.payload.job_id !== parsed.input.job_id || active.payload.cycle !== parsed.input.cycle
    || active.payload.run_id !== parsed.input.run_id) {
    fail('LEASE_INVALID', 'The worker lease does not match the runtime evidence.');
  }
  const context = runtimeContext(active);
  return withImmediateTransaction(db, () => insertEvidenceInTransaction(
    db,
    audit,
    parsed.input,
    parsed.detail,
    context,
    requestId,
    options,
  ));
}

function encodeCursor(cursor: Cursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  if (byteLength(encoded) > MAX_CURSOR_BYTES) fail('INVALID_INPUT', 'The evidence cursor exceeds its bound.');
  return encoded;
}

function decodeCursor(value: string, jobId: string, cycle: number | undefined): Cursor {
  if (byteLength(value) > MAX_CURSOR_BYTES) fail('INVALID_INPUT', 'The evidence cursor exceeds its bound.');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('cursor object required');
    const candidate = parsed as Record<string, unknown>;
    if (candidate['version'] !== 1 || candidate['job_id'] !== jobId
      || (candidate['cycle'] !== null && candidate['cycle'] !== cycle)
      || typeof candidate['created_at'] !== 'string' || typeof candidate['evidence_id'] !== 'string') {
      throw new Error('cursor filter mismatch');
    }
    return {
      version: 1,
      job_id: jobId,
      cycle: candidate['cycle'] as number | null,
      created_at: candidate['created_at'],
      evidence_id: candidate['evidence_id'],
    };
  } catch {
    fail('INVALID_INPUT', 'The evidence cursor is invalid.');
  }
}

export function listEvidence(
  db: SqliteDatabase,
  actor: VerifiedActorAuthInfo,
  rawInput: unknown,
): EvidenceListResult {
  if (!validActor(actor) || (actor.role !== 'principal' && actor.role !== 'observer')
    || !hasCapability(actor.capabilities, 'job:read')) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot read evidence.');
  }
  const parsed = EvidenceListInputSchema.safeParse(rawInput);
  if (!parsed.success) fail('INVALID_INPUT', 'The evidence list input is invalid.');
  const input = parsed.data;
  if (byteLength(input.job_id) > MAX_IDENTIFIER_BYTES) fail('INVALID_INPUT', 'The job identifier exceeds its bound.');
  const job = loadJob(db, input.job_id);
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, input.job_id, input.cycle);
  const limit = input.limit ?? 50;
  const clauses = ['job_id = ?'];
  const params: unknown[] = [job.job_id];
  if (input.cycle !== undefined) {
    clauses.push('cycle = ?');
    params.push(input.cycle);
  }
  if (cursor !== undefined) {
    clauses.push('(created_at > ? OR (created_at = ? AND evidence_id > ?))');
    params.push(cursor.created_at, cursor.created_at, cursor.evidence_id);
  }
  const rows = db.prepare(
    `SELECT evidence_id, job_id, cycle, run_id, source_actor, trust, kind, severity, summary, detail_json, artifact_id, created_at
       FROM evidence WHERE ${clauses.join(' AND ')}
       ORDER BY created_at, evidence_id LIMIT ?`,
  ).all(...params, limit + 1) as EvidenceSqlRow[];
  const hasNext = rows.length > limit;
  const selected = hasNext ? rows.slice(0, limit) : rows;
  const evidence = selected.map(parseStored);
  if (!hasNext || evidence.length === 0) return { evidence };
  const last = evidence[evidence.length - 1];
  if (last === undefined) return { evidence };
  return {
    evidence,
    next_cursor: encodeCursor({
      version: 1,
      job_id: input.job_id,
      cycle: input.cycle ?? null,
      created_at: last.created_at,
      evidence_id: last.evidence_id,
    }),
  };
}
