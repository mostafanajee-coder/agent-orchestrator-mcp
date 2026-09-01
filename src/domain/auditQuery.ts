import { verifyAuditRange } from '../authority/audit.js';
import type { SqliteDatabase } from '../store/db.js';
import { redactSensitiveDetail } from '../security/redaction.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_CURSOR_BYTES = 2_048;
const MAX_DETAIL_BYTES = 4_096;

export const AUDIT_QUERY_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const AUDIT_QUERY_MAX_LIMIT = MAX_LIMIT;

export interface AuditQueryInput {
  readonly job_id?: string;
  readonly session_token_id?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly verify_range?: boolean;
}

export interface AuditQueryEvent {
  readonly seq: number;
  readonly ts: string;
  readonly actor_id: string;
  readonly actor_role: 'principal' | 'worker' | 'observer' | 'system';
  readonly session_token_id: string | null;
  readonly request_id: string;
  readonly action: string;
  readonly job_id: string | null;
  readonly cycle: number | null;
  readonly capability: string | null;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly from_state: string | null;
  readonly to_state: string | null;
  readonly from_auth_status: string | null;
  readonly to_auth_status: string | null;
  readonly result: 'ok' | 'denied' | 'error';
  readonly detail_json: string | null;
  readonly detail_truncated: boolean;
}

export interface AuditQueryResult {
  readonly events: readonly AuditQueryEvent[];
  readonly next_cursor?: string;
  readonly chain_valid?: true;
}

export type AuditQueryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CURSOR'
  | 'QUERY_LIMIT_EXCEEDED'
  | 'AUDIT_CHAIN_BROKEN'
  | 'INTERNAL_ERROR';

export class AuditQueryError extends Error {
  public override readonly name = 'AuditQueryError';

  public constructor(
    public readonly code: AuditQueryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface SqlAuditQueryRow {
  readonly seq: unknown;
  readonly ts: unknown;
  readonly actor_id: unknown;
  readonly actor_role: unknown;
  readonly session_token_id: unknown;
  readonly request_id: unknown;
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
}

interface Cursor {
  readonly v: 1;
  readonly before_seq: number;
  readonly job_id: string | null;
  readonly session_token_id: string | null;
}

function fail(code: AuditQueryErrorCode, message: string): never {
  throw new AuditQueryError(code, message);
}

function filterText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('INVALID_INPUT', field + ' is invalid.');
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 256 || /[\0\r\n]/.test(trimmed)) {
    fail('INVALID_INPUT', field + ' is invalid.');
  }
  return trimmed;
}

function encodeCursor(cursor: Cursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CURSOR_BYTES) {
    fail('INTERNAL_ERROR', 'The audit cursor exceeds its bound.');
  }
  return encoded;
}

function decodeCursor(
  value: string,
  jobId: string | undefined,
  sessionTokenId: string | undefined,
): Cursor {
  if (Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('INVALID_CURSOR', 'The audit cursor is invalid.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    fail('INVALID_CURSOR', 'The audit cursor is invalid.');
  }
  if (parsed === null || typeof parsed !== 'object') fail('INVALID_CURSOR', 'The audit cursor is invalid.');
  const candidate = parsed as Record<string, unknown>;
  const beforeSeq = candidate['before_seq'];
  const cursorJobId = candidate['job_id'];
  const cursorSessionId = candidate['session_token_id'];
  if (candidate['v'] !== 1
    || !Number.isSafeInteger(beforeSeq) || (beforeSeq as number) <= 0
    || (cursorJobId !== null && typeof cursorJobId !== 'string')
    || (cursorSessionId !== null && typeof cursorSessionId !== 'string')
    || (cursorJobId !== null && cursorJobId !== jobId)
    || (cursorSessionId !== null && cursorSessionId !== sessionTokenId)) {
    fail('INVALID_CURSOR', 'The audit cursor does not match the requested filters.');
  }
  return {
    v: 1,
    before_seq: beforeSeq as number,
    job_id: cursorJobId as string | null,
    session_token_id: cursorSessionId as string | null,
  };
}

function safeDetail(value: unknown): { readonly json: string | null; readonly truncated: boolean } {
  if (value === null || value === undefined) return { json: null, truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value)) as unknown;
  } catch {
    return { json: null, truncated: true };
  }
  let json: string;
  try {
    json = JSON.stringify(redactSensitiveDetail(parsed, [], { redactAbsolutePaths: true }));
  } catch {
    return { json: null, truncated: true };
  }
  if (Buffer.byteLength(json, 'utf8') <= MAX_DETAIL_BYTES) return { json, truncated: false };
  return { json: JSON.stringify({ redacted: true, truncated: true }), truncated: true };
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function eventFromRow(row: SqlAuditQueryRow): AuditQueryEvent {
  const seq = Number(row.seq);
  if (!Number.isSafeInteger(seq) || seq <= 0) fail('INTERNAL_ERROR', 'The audit sequence is invalid.');
  const result = row.result;
  if (result !== 'ok' && result !== 'denied' && result !== 'error') {
    fail('INTERNAL_ERROR', 'The audit result is invalid.');
  }
  const detail = safeDetail(row.detail_json);
  return {
    seq,
    ts: String(row.ts),
    actor_id: String(row.actor_id),
    actor_role: row.actor_role as AuditQueryEvent['actor_role'],
    session_token_id: nullableText(row.session_token_id),
    request_id: String(row.request_id),
    action: String(row.action),
    job_id: nullableText(row.job_id),
    cycle: row.cycle === null || row.cycle === undefined ? null : Number(row.cycle),
    capability: nullableText(row.capability),
    subject_type: nullableText(row.subject_type),
    subject_id: nullableText(row.subject_id),
    from_state: nullableText(row.from_state),
    to_state: nullableText(row.to_state),
    from_auth_status: nullableText(row.from_auth_status),
    to_auth_status: nullableText(row.to_auth_status),
    result,
    detail_json: detail.json,
    detail_truncated: detail.truncated,
  };
}

/** Reads a bounded, redacted audit page without mutating the ledger. */
export function listAudit(
  db: SqliteDatabase,
  rawInput: AuditQueryInput,
): AuditQueryResult {
  const jobId = filterText(rawInput.job_id, 'job_id');
  const sessionTokenId = filterText(rawInput.session_token_id, 'session_token_id');
  const limit = rawInput.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    fail('QUERY_LIMIT_EXCEEDED', 'The audit query limit exceeds its bound.');
  }
  if (rawInput.verify_range !== undefined && typeof rawInput.verify_range !== 'boolean') {
    fail('INVALID_INPUT', 'verify_range is invalid.');
  }
  const cursor = rawInput.cursor === undefined
    ? undefined
    : decodeCursor(rawInput.cursor, jobId, sessionTokenId);
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (jobId !== undefined) {
    clauses.push('job_id = ?');
    params.push(jobId);
  }
  if (sessionTokenId !== undefined) {
    clauses.push('session_token_id = ?');
    params.push(sessionTokenId);
  }
  if (cursor !== undefined) {
    clauses.push('seq < ?');
    params.push(cursor.before_seq);
  }
  const where = clauses.length === 0 ? '' : ' WHERE ' + clauses.join(' AND ');
  const rows = db.prepare(
    `SELECT seq, ts, actor_id, actor_role, session_token_id, request_id, action,
            job_id, cycle, capability, subject_type, subject_id, from_state,
            to_state, from_auth_status, to_auth_status, result, detail_json
       FROM audit_log${where}
      ORDER BY seq DESC
      LIMIT ?`,
  ).all(...params, limit + 1) as SqlAuditQueryRow[];
  const pageRows = rows.slice(0, limit);
  if (rawInput.verify_range === true && pageRows.length > 0) {
    const ascending = [...pageRows].sort((left, right) => Number(left.seq) - Number(right.seq));
    const first = Number(ascending[0]?.seq);
    const last = Number(ascending[ascending.length - 1]?.seq);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first >= MAX_LIMIT) {
      fail('QUERY_LIMIT_EXCEEDED', 'The requested audit verification range exceeds its bound.');
    }
    const range = verifyAuditRange(db, first, last);
    if (!range.valid) fail('AUDIT_CHAIN_BROKEN', 'The requested audit range failed chain verification.');
  }
  const events = pageRows.map(eventFromRow);
  const result: AuditQueryResult = {
    events,
    ...(rawInput.verify_range === true ? { chain_valid: true as const } : {}),
  };
  if (rows.length > limit && events.length > 0) {
    const last = events[events.length - 1];
    if (last === undefined) fail('INTERNAL_ERROR', 'The audit page is invalid.');
    const nextCursor = encodeCursor({
      v: 1,
      before_seq: last.seq,
      job_id: jobId ?? null,
      session_token_id: sessionTokenId ?? null,
    });
    return { ...result, next_cursor: nextCursor };
  }
  return result;
}
