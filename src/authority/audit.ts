import { createHash } from 'node:crypto';

import type { SqliteDatabase } from '../store/db.js';
import { withImmediateTransaction } from '../store/db.js';
import { redactSensitiveDetail, redactSensitiveText } from '../security/redaction.js';

import { CAPABILITY_VALUES } from './capabilities.js';
import type { ActorRole, Capability } from './capabilities.js';
import {
  EDGE_ADMISSION_DENIAL_REASONS,
  type EdgeAdmissionDenialReason,
} from './policy.js';

export const AUDIT_DETAIL_MAX_BYTES = 65_536;
export const AUDIT_REJECTED_AUTH_WINDOW_MS = 60_000;
export const AUDIT_REJECTED_AUTH_MAX_PER_WINDOW = 100;
export const AUDIT_GENESIS_HASH = '0'.repeat(64);
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const AUDIT_ACTION_VALUES = [
  'bootstrap.completed',
  'actor.created',
  'token.issued',
  'token.revoked',
  'auth.rejected',
  'startup.invariant_failed',
  'authorization.state_initialized',
  'authorization.epoch_rotated',
  'authorization.state_invalid',
  'authorization.clock_rollback',
  'authorization.clock_recovered',
  'job.create',
  'job.start',
  'job.resume',
  'qa.dispatch',
  'run.start',
  'run.report',
  'run.failed',
  'run.timeout',
  'run.cancelled',
  'run.orphaned',
  'run.duplicate_rejected',
  'lease.issued',
  'lease.consumed',
  'lease.rejected',
  'system.runs_settled',
  'system.stall',
  'evidence.add',
  'evidence.rejected',
  'artifact.register',
  'artifact.rejected',
  'artifact.hash_mismatch',
  'artifact.quota_rejected',
  'codex.decide',
  'edge.admission_denied',
] as const;
export type AuditAction = (typeof AUDIT_ACTION_VALUES)[number];

export { EDGE_ADMISSION_DENIAL_REASONS };
export type { EdgeAdmissionDenialReason };

export type AuditResult = 'ok' | 'denied' | 'error';

export interface AuditEventInput {
  readonly actorId: string;
  readonly actorRole: ActorRole;
  readonly sessionTokenId?: string | null;
  readonly requestId: string;
  readonly sessionHint?: string | null;
  readonly action: AuditAction;
  readonly jobId?: string | null;
  readonly cycle?: number | null;
  readonly capability?: Capability | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly fromState?: string | null;
  readonly toState?: string | null;
  readonly fromAuthStatus?: string | null;
  readonly toAuthStatus?: string | null;
  readonly result: AuditResult;
  readonly detail?: unknown;
  /** Ephemeral values to remove from this event; never persisted. */
  readonly secretValues?: readonly string[];
  readonly timestamp?: string;
}

export interface AuditRow {
  readonly seq: number;
  readonly ts: string;
  readonly actorId: string;
  readonly actorRole: ActorRole;
  readonly sessionTokenId: string | null;
  readonly requestId: string;
  readonly sessionHint: string | null;
  readonly action: AuditAction;
  readonly jobId: string | null;
  readonly cycle: number | null;
  readonly capability: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly fromAuthStatus: string | null;
  readonly toAuthStatus: string | null;
  readonly result: AuditResult;
  readonly detailJson: string | null;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditChainReport {
  readonly valid: boolean;
  readonly firstInvalidSeq?: number;
}

export interface AuditWriterOptions {
  /** Optional secret values to remove from free-form detail before storage. */
  readonly secretValues?: readonly string[];
}

export class AuditError extends Error {
  public override readonly name = 'AuditError';
}

interface SequenceRow {
  readonly seq?: unknown;
}

interface SqlAuditRow {
  readonly seq: unknown;
  readonly ts: unknown;
  readonly actor_id: unknown;
  readonly actor_role: unknown;
  readonly session_token_id: unknown;
  readonly request_id: unknown;
  readonly session_hint: unknown;
  readonly action: unknown;
  readonly job_id: unknown;
  readonly cycle: unknown;
  readonly capability: unknown;
  readonly subject_type: unknown;
  readonly subject_id: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly from_auth_status: unknown;
  readonly to_auth_status: unknown;
  readonly result: unknown;
  readonly detail_json: unknown;
  readonly prev_hash: unknown;
  readonly hash: unknown;
}

function boundedText(
  value: string | null | undefined,
  field: string,
  secretValues: readonly string[] = [],
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new AuditError(field + ' is invalid.');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 256) throw new AuditError(field + ' exceeds the audit bound.');
  return redactString(trimmed, secretValues);
}

function requiredText(value: string, field: string, secretValues: readonly string[] = []): string {
  const result = boundedText(value, field, secretValues);
  if (result === null) throw new AuditError(field + ' is required.');
  return result;
}

function requiredAction(value: AuditAction): AuditAction {
  if (!(AUDIT_ACTION_VALUES as readonly string[]).includes(value)) {
    throw new AuditError('action is not an approved audit action.');
  }
  return value;
}

function redactString(value: string, secretValues: readonly string[] = []): string {
  return redactSensitiveText(value, secretValues, { redactAbsolutePaths: true });
}

function redactDetail(value: unknown, secretValues: readonly string[]): unknown {
  return redactSensitiveDetail(value, secretValues, { redactAbsolutePaths: true });
}

function detailJson(value: unknown, secretValues: readonly string[]): string | null {
  if (value === undefined || value === null) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(redactDetail(value, secretValues));
  } catch {
    throw new AuditError('Audit detail is not serializable.');
  }
  if (json === undefined) return null;
  if (Buffer.byteLength(json, 'utf8') > AUDIT_DETAIL_MAX_BYTES) {
    throw new AuditError('Audit detail exceeds the configured bound.');
  }
  return json;
}

function nextSequence(db: SqliteDatabase): number {
  const row = db.prepare(
    "SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'",
  ).get() as SequenceRow | undefined;
  const current = row?.seq === undefined ? 0 : Number(row.seq);
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new AuditError('The audit sequence state is invalid.');
  }
  return current + 1;
}

function canonicalHashInput(row: AuditRow): string {
  return JSON.stringify({
    seq: row.seq,
    ts: row.ts,
    actor_id: row.actorId,
    actor_role: row.actorRole,
    session_token_id: row.sessionTokenId,
    request_id: row.requestId,
    session_hint: row.sessionHint,
    action: row.action,
    job_id: row.jobId,
    cycle: row.cycle,
    capability: row.capability,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    from_state: row.fromState,
    to_state: row.toState,
    from_auth_status: row.fromAuthStatus,
    to_auth_status: row.toAuthStatus,
    result: row.result,
    detail_json: row.detailJson,
    prev_hash: row.prevHash,
  });
}

function readSequenceAfterInsert(db: SqliteDatabase): number {
  const row = db.prepare('SELECT last_insert_rowid() AS seq').get() as { readonly seq?: unknown };
  const seq = Number(row.seq);
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new AuditError('The audit sequence allocation is invalid.');
  return seq;
}

export class AuditWriter {
  private rejectedWindowStart = 0;
  private rejectedWindowCount = 0;

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: () => number = () => Date.now(),
    private readonly rejectedAuthCap = AUDIT_REJECTED_AUTH_MAX_PER_WINDOW,
    options: AuditWriterOptions = {},
  ) {
    this.secretValues = (options.secretValues ?? []).filter((value) => value !== '');
  }

  private readonly secretValues: readonly string[];

  /** Appends an entry and owns a transaction for standalone events. */
  public append(input: AuditEventInput): AuditRow {
    return withImmediateTransaction(this.db, () => this.appendInTransaction(input));
  }

  /** Appends an entry to a transaction already owned by the caller. */
  public appendInTransaction(input: AuditEventInput): AuditRow {
    if (!this.db.inTransaction) {
      throw new AuditError('Audit append requires an active transaction.');
    }
    const tail = auditTail(this.db);
    const seq = tail.seq;
    const timestamp = input.timestamp ?? new Date(this.clock()).toISOString();
    if (!RFC3339_UTC.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
      throw new AuditError('timestamp must be a valid RFC3339 UTC value.');
    }
    if (
      input.actorRole !== 'principal'
      && input.actorRole !== 'worker'
      && input.actorRole !== 'observer'
      && input.actorRole !== 'system'
      && input.actorRole !== 'edge'
    ) {
      throw new AuditError('actorRole is invalid.');
    }
    if (input.capability !== null && input.capability !== undefined
      && !(CAPABILITY_VALUES as readonly string[]).includes(input.capability)) {
      throw new AuditError('capability is invalid.');
    }
    if (input.cycle !== null && input.cycle !== undefined
      && (!Number.isSafeInteger(input.cycle) || input.cycle < 0)) {
      throw new AuditError('cycle is invalid.');
    }
    if (input.result !== 'ok' && input.result !== 'denied' && input.result !== 'error') {
      throw new AuditError('result is invalid.');
    }
    const secretValues = [
      ...this.secretValues,
      ...(input.secretValues ?? []),
    ].filter((value) => value !== '');
    const row: AuditRow = {
      seq,
      ts: timestamp,
      actorId: requiredText(input.actorId, 'actorId', secretValues),
      actorRole: input.actorRole,
      sessionTokenId: boundedText(input.sessionTokenId, 'sessionTokenId'),
      requestId: requiredText(input.requestId, 'requestId', secretValues),
      sessionHint: boundedText(input.sessionHint, 'sessionHint', secretValues),
      action: requiredAction(input.action),
      jobId: boundedText(input.jobId, 'jobId'),
      cycle: input.cycle ?? null,
      capability: input.capability ?? null,
      subjectType: boundedText(input.subjectType, 'subjectType'),
      subjectId: boundedText(input.subjectId, 'subjectId'),
      fromState: boundedText(input.fromState, 'fromState'),
      toState: boundedText(input.toState, 'toState'),
      fromAuthStatus: boundedText(input.fromAuthStatus, 'fromAuthStatus'),
      toAuthStatus: boundedText(input.toAuthStatus, 'toAuthStatus'),
      result: input.result,
      detailJson: detailJson(input.detail, secretValues),
      prevHash: tail.prevHash,
      hash: '',
    };
    const hash = createHash('sha256').update(canonicalHashInput(row), 'utf8').digest('hex');
    const complete = { ...row, hash };
    this.db.prepare(
      'INSERT INTO audit_log(ts, actor_id, actor_role, session_token_id, request_id, session_hint, action, job_id, cycle, capability, subject_type, subject_id, from_state, to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      complete.ts,
      complete.actorId,
      complete.actorRole,
      complete.sessionTokenId,
      complete.requestId,
      complete.sessionHint,
      complete.action,
      complete.jobId,
      complete.cycle,
      complete.capability,
      complete.subjectType,
      complete.subjectId,
      complete.fromState,
      complete.toState,
      complete.fromAuthStatus,
      complete.toAuthStatus,
      complete.result,
      complete.detailJson,
      complete.prevHash,
      complete.hash,
    );
    if (readSequenceAfterInsert(this.db) !== seq) {
      throw new AuditError('The audit sequence changed unexpectedly.');
    }
    return complete;
  }

  /** Records a fixed, redacted edge-admission denial without granting authority. */
  public appendEdgeAdmissionDenied(input: {
    readonly actorId: string;
    readonly sessionTokenId?: string | null;
    readonly integrationId?: string | null;
    readonly requestId: string;
    readonly reason: EdgeAdmissionDenialReason;
    readonly timestamp?: string;
  }): AuditRow {
    if (!(EDGE_ADMISSION_DENIAL_REASONS as readonly string[]).includes(input.reason)) {
      throw new AuditError('The edge admission denial reason is not approved.');
    }
    return this.append({
      actorId: input.actorId,
      actorRole: 'edge',
      ...(input.sessionTokenId === undefined ? {} : { sessionTokenId: input.sessionTokenId }),
      requestId: input.requestId,
      action: 'edge.admission_denied',
      capability: 'delegation:request',
      subjectType: 'integration',
      ...(input.integrationId === undefined ? {} : { subjectId: input.integrationId }),
      result: 'denied',
      detail: { reason: input.reason },
      timestamp: input.timestamp ?? new Date(this.clock()).toISOString(),
    });
  }

  /** Records bounded metadata for an unauthenticated/rejected request. */
  public recordRejectedAuth(requestId: string, detail?: unknown): boolean {
    const now = this.clock();
    if (now - this.rejectedWindowStart >= AUDIT_REJECTED_AUTH_WINDOW_MS) {
      this.rejectedWindowStart = now;
      this.rejectedWindowCount = 0;
    }
    if (this.rejectedWindowCount >= this.rejectedAuthCap) return false;
    this.append({
      actorId: 'system',
      actorRole: 'system',
      sessionTokenId: null,
      requestId,
      sessionHint: null,
      action: 'auth.rejected',
      result: 'denied',
      detail,
      timestamp: new Date(now).toISOString(),
    });
    this.rejectedWindowCount += 1;
    return true;
  }
}

function auditRowFromSql(row: SqlAuditRow): AuditRow {
  return {
    seq: Number(row.seq),
    ts: String(row.ts),
    actorId: String(row.actor_id),
    actorRole: row.actor_role as ActorRole,
    sessionTokenId: row.session_token_id === null ? null : String(row.session_token_id),
    requestId: String(row.request_id),
    sessionHint: row.session_hint === null ? null : String(row.session_hint),
    action: row.action as AuditAction,
    jobId: row.job_id === null ? null : String(row.job_id),
    cycle: row.cycle === null ? null : Number(row.cycle),
    capability: row.capability === null ? null : String(row.capability),
    subjectType: row.subject_type === null ? null : String(row.subject_type),
    subjectId: row.subject_id === null ? null : String(row.subject_id),
    fromState: row.from_state === null ? null : String(row.from_state),
    toState: row.to_state === null ? null : String(row.to_state),
    fromAuthStatus: row.from_auth_status === null ? null : String(row.from_auth_status),
    toAuthStatus: row.to_auth_status === null ? null : String(row.to_auth_status),
    result: row.result as AuditResult,
    detailJson: row.detail_json === null ? null : String(row.detail_json),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
  };
}

/** Validates only the current tail; the complete chain is checked at startup. */
function auditTail(db: SqliteDatabase): { readonly seq: number; readonly prevHash: string } {
  const currentNext = nextSequence(db);
  const raw = db.prepare(
    'SELECT seq, ts, actor_id, actor_role, session_token_id, request_id, session_hint, action, job_id, cycle, capability, subject_type, subject_id, from_state, to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash, hash FROM audit_log ORDER BY seq DESC LIMIT 1',
  ).get() as SqlAuditRow | undefined;
  if (raw === undefined) {
    if (currentNext !== 1) throw new AuditError('The audit sequence state has no matching tail row.');
    return { seq: 1, prevHash: AUDIT_GENESIS_HASH };
  }

  const row = auditRowFromSql(raw);
  if (
    !Number.isSafeInteger(row.seq)
    || row.seq <= 0
    || row.seq + 1 !== currentNext
    || !HEX_DIGEST.test(row.prevHash)
    || !HEX_DIGEST.test(row.hash)
    || (row.seq === 1 && row.prevHash !== AUDIT_GENESIS_HASH)
    || !(AUDIT_ACTION_VALUES as readonly string[]).includes(row.action)
  ) {
    throw new AuditError('The current audit tail is invalid.');
  }
  const expectedHash = createHash('sha256').update(canonicalHashInput(row), 'utf8').digest('hex');
  if (row.hash !== expectedHash) throw new AuditError('The current audit tail hash is invalid.');
  return { seq: currentNext, prevHash: row.hash };
}

/** Validates one bounded audit range plus its immediate predecessor anchor. */
export function verifyAuditRange(
  db: SqliteDatabase,
  firstSeq: number,
  lastSeq: number,
): AuditChainReport {
  if (!Number.isSafeInteger(firstSeq) || !Number.isSafeInteger(lastSeq)
    || firstSeq < 1 || lastSeq < firstSeq || lastSeq - firstSeq >= 200) {
    return { valid: false, firstInvalidSeq: firstSeq };
  }
  let previous = AUDIT_GENESIS_HASH;
  if (firstSeq > 1) {
    const anchor = db.prepare(
      'SELECT seq, ts, actor_id, actor_role, session_token_id, request_id, session_hint, action, job_id, cycle, capability, subject_type, subject_id, from_state, to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash, hash FROM audit_log WHERE seq = ?',
    ).get(firstSeq - 1) as SqlAuditRow | undefined;
    if (anchor === undefined) return { valid: false, firstInvalidSeq: firstSeq - 1 };
    const anchorRow = auditRowFromSql(anchor);
    if (
      anchorRow.seq !== firstSeq - 1
      || !HEX_DIGEST.test(anchorRow.prevHash)
      || !HEX_DIGEST.test(anchorRow.hash)
      || !(AUDIT_ACTION_VALUES as readonly string[]).includes(anchorRow.action)
    ) return { valid: false, firstInvalidSeq: firstSeq - 1 };
    const expectedAnchor = createHash('sha256').update(canonicalHashInput(anchorRow), 'utf8').digest('hex');
    if (anchorRow.hash !== expectedAnchor) return { valid: false, firstInvalidSeq: firstSeq - 1 };
    previous = anchorRow.hash;
  }
  const rows = db.prepare(
    'SELECT seq, ts, actor_id, actor_role, session_token_id, request_id, session_hint, action, job_id, cycle, capability, subject_type, subject_id, from_state, to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash, hash FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq',
  ).all(firstSeq, lastSeq) as SqlAuditRow[];
  let expectedSequence = firstSeq;
  for (const raw of rows) {
    const row = auditRowFromSql(raw);
    if (
      row.seq !== expectedSequence
      || !Number.isSafeInteger(row.seq)
      || row.seq <= 0
      || !HEX_DIGEST.test(row.prevHash)
      || !HEX_DIGEST.test(row.hash)
      || !(AUDIT_ACTION_VALUES as readonly string[]).includes(row.action)
      || row.prevHash !== previous
    ) {
      return { valid: false, firstInvalidSeq: row.seq };
    }
    const expected = createHash('sha256').update(canonicalHashInput(row), 'utf8').digest('hex');
    if (row.hash !== expected) return { valid: false, firstInvalidSeq: row.seq };
    previous = row.hash;
    expectedSequence += 1;
  }
  if (expectedSequence !== lastSeq + 1) return { valid: false, firstInvalidSeq: expectedSequence };
  return { valid: true };
}

export function verifyAuditChain(db: SqliteDatabase): AuditChainReport {
  const rows = db.prepare(
    'SELECT seq, ts, actor_id, actor_role, session_token_id, request_id, session_hint, action, job_id, cycle, capability, subject_type, subject_id, from_state, to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash, hash FROM audit_log ORDER BY seq',
  ).all() as SqlAuditRow[];
  let previous = AUDIT_GENESIS_HASH;
  let expectedSequence = 1;
  for (const raw of rows) {
    const row = auditRowFromSql(raw);
    if (
      row.seq !== expectedSequence
      || !Number.isSafeInteger(row.seq)
      || row.seq <= 0
      || !HEX_DIGEST.test(row.prevHash)
      || !HEX_DIGEST.test(row.hash)
      || !(AUDIT_ACTION_VALUES as readonly string[]).includes(row.action)
    ) {
      return { valid: false, firstInvalidSeq: row.seq };
    }
    if (row.prevHash !== previous) return { valid: false, firstInvalidSeq: row.seq };
    const expected = createHash('sha256').update(canonicalHashInput(row), 'utf8').digest('hex');
    if (row.hash !== expected) return { valid: false, firstInvalidSeq: row.seq };
    previous = row.hash;
    expectedSequence += 1;
  }
  return { valid: true };
}
