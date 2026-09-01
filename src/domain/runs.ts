import { createHash } from 'node:crypto';

import { z } from 'zod/v4';

import {
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  hasCapability,
} from '../authority/capabilities.js';
import type { AuditWriter } from '../authority/audit.js';
import type { SqliteDatabase } from '../store/db.js';
import { withImmediateTransaction } from '../store/db.js';
import type { Phase6WorkerRegistry, WorkerDefinitionFile } from '../config/phase6.js';
import type { VerifiedActorAuthInfo } from '../mcp/auth.js';
import { redactSensitiveText } from '../security/redaction.js';
import {
  createLeaseMaterial,
  LeaseError,
  verifyLease,
  type LeasePayload,
} from '../workers/lease.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TASK_BYTES = 8_192;
const MAX_PARAMS_BYTES = 32_768;
const MAX_SUMMARY_BYTES = 2_048;
const MAX_RUNS_PER_DISPATCH = 16;
const MAX_LEASE_TIMEOUT_MS = 900_000;

export const RUN_STATUS_VALUES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'MALFORMED',
  'ORPHANED',
] as const;
export type RunStatus = (typeof RUN_STATUS_VALUES)[number];

export const RUN_TERMINAL_STATUS_VALUES = [
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'MALFORMED',
  'ORPHANED',
] as const satisfies readonly RunStatus[];

export const WORKER_VERDICT_VALUES = ['PASS', 'FAIL', 'INCONCLUSIVE', 'NONE'] as const;
export type WorkerVerdict = (typeof WORKER_VERDICT_VALUES)[number];

export const RUN_FAILURE_CLASS_VALUES = [
  'SPAWN_FAILED',
  'TRANSIENT',
  'AUTH_REQUIRED',
  'MALFORMED_OUTPUT',
  'TIMEOUT',
  'MODEL_ERROR',
] as const;
export type RunFailureClass = (typeof RUN_FAILURE_CLASS_VALUES)[number];

export const QaDispatchInputSchema = z.object({
  job_id: z.string().trim().min(1).max(256),
  cycle: z.number().int().nonnegative(),
  expected_version: z.number().int().positive(),
  requests: z.array(z.object({
    worker_id: z.string().trim().min(1).max(64),
    task: z.string().trim().min(1).max(MAX_TASK_BYTES),
    params: z.record(z.string(), z.unknown()).optional(),
    timeout_ms: z.number().int().min(1_000).max(MAX_LEASE_TIMEOUT_MS).optional(),
  }).strict()).min(1).max(MAX_RUNS_PER_DISPATCH),
  idempotency_key: z.string().regex(UUID_PATTERN).optional(),
  session_hint: z.string().trim().min(1).max(256).optional(),
}).strict();

export const RunReportInputSchema = z.object({
  lease: z.string().trim().min(1).max(16_384),
  verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  summary: z.string().trim().min(1).max(MAX_SUMMARY_BYTES),
  usage: z.record(z.string(), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).optional(),
}).strict();

export const RunStatusInputSchema = z.object({
  job_id: z.string().trim().min(1).max(256),
  cycle: z.number().int().nonnegative().optional(),
  run_id: z.string().trim().min(1).max(256).optional(),
}).strict();

export type QaDispatchInput = z.infer<typeof QaDispatchInputSchema>;
export type RunReportInput = z.infer<typeof RunReportInputSchema>;
export type RunStatusInput = z.infer<typeof RunStatusInputSchema>;

export interface RunSummary {
  readonly run_id: string;
  readonly job_id: string;
  readonly cycle: number;
  readonly worker_id: string;
  readonly status: RunStatus;
  readonly worker_verdict: WorkerVerdict | null;
  readonly failure_class: RunFailureClass | null;
  readonly attempt: number;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

export interface DispatchPublicResult {
  readonly job_id: string;
  readonly cycle: number;
  readonly state: 'QA_RUNNING';
  readonly version: number;
  readonly runs: readonly {
    readonly run_id: string;
    readonly worker_id: string;
    readonly status: 'PENDING';
  }[];
}

export interface DispatchResult extends DispatchPublicResult {
  /** Internal only; never included in the MCP response or idempotency row. */
  readonly runtimeLeases: readonly {
    readonly run_id: string;
    readonly lease: string;
    readonly worker_id: string;
  }[];
}

export interface ReportResult {
  readonly run_id: string;
  readonly job_id: string;
  readonly cycle: number;
  readonly status: RunStatus;
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly job_state: string;
}

export interface Phase6RunOptions {
  readonly registry: Phase6WorkerRegistry;
  readonly leaseKey: Buffer;
  readonly clock?: () => number;
  /** Phase 8 shutdown gate; a false value rejects new dispatches. */
  readonly acceptingWork?: () => boolean;
  /** Phase 7 artifact staging root; absent for legacy Phase 6 fixtures. */
  readonly artifactsRoot?: string;
}

export type RunLifecycleErrorCode =
  | 'INVALID_INPUT'
  | 'JOB_NOT_FOUND'
  | 'WORKER_NOT_FOUND'
  | 'WORKER_DISABLED'
  | 'AUTHORIZATION_DENIED'
  | 'STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'LEASE_REJECTED'
  | 'RUN_NOT_FOUND'
  | 'SERVICE_SHUTTING_DOWN'
  | 'INTERNAL_ERROR';

export const RUN_LIFECYCLE_ERROR_CODES = [
  'INVALID_INPUT',
  'JOB_NOT_FOUND',
  'WORKER_NOT_FOUND',
  'WORKER_DISABLED',
  'AUTHORIZATION_DENIED',
  'STATE_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'LEASE_REJECTED',
  'RUN_NOT_FOUND',
  'SERVICE_SHUTTING_DOWN',
  'INTERNAL_ERROR',
] as const satisfies readonly RunLifecycleErrorCode[];

export class RunLifecycleError extends Error {
  public override readonly name = 'RunLifecycleError';

  public constructor(
    public readonly code: RunLifecycleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface JobRow {
  readonly job_id: string;
  readonly workspace: string;
  readonly cycle: number;
  readonly state: string;
  readonly version: number;
  readonly max_cycles: number;
  readonly deadline_at: string | null;
}

interface RunSqlRow {
  readonly run_id: unknown;
  readonly job_id: unknown;
  readonly cycle: unknown;
  readonly worker_id: unknown;
  readonly adapter: unknown;
  readonly request_json: unknown;
  readonly status: unknown;
  readonly worker_verdict: unknown;
  readonly failure_class: unknown;
  readonly attempt: unknown;
  readonly started_at: unknown;
  readonly ended_at: unknown;
  readonly created_at: unknown;
  readonly pid: unknown;
  readonly exit_code: unknown;
  readonly usage_json: unknown;
  readonly workspace?: unknown;
  readonly job_state?: unknown;
  readonly deadline_at?: unknown;
}

interface LeaseSqlRow {
  readonly lease_id: unknown;
  readonly run_id: unknown;
  readonly job_id: unknown;
  readonly cycle: unknown;
  readonly actor_id: unknown;
  readonly nonce: unknown;
  readonly expires_at: unknown;
  readonly consumed_at: unknown;
}

interface IdempotencyRow {
  readonly request_hash: unknown;
  readonly response_json: unknown;
}

interface StoredDispatchResult {
  readonly job_id: string;
  readonly cycle: number;
  readonly state: 'QA_RUNNING';
  readonly version: number;
  readonly runs: readonly {
    readonly run_id: string;
    readonly worker_id: string;
    readonly status: 'PENDING';
  }[];
}

function nowIso(options: Phase6RunOptions): string {
  return new Date((options.clock ?? (() => Date.now()))()).toISOString();
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function safeWorkerText(value: string, secretValues: readonly string[] = []): string {
  return redactSensitiveText(value, secretValues, { redactAbsolutePaths: true });
}

function fail(code: RunLifecycleErrorCode, message: string): never {
  throw new RunLifecycleError(code, message);
}

function parseDispatchInput(raw: unknown): QaDispatchInput {
  const parsed = QaDispatchInputSchema.safeParse(raw);
  if (!parsed.success) fail('INVALID_INPUT', 'The QA dispatch input is invalid.');
  for (const request of parsed.data.requests) {
    if (bytes(request.task) > MAX_TASK_BYTES) fail('INVALID_INPUT', 'A worker task exceeds its bound.');
    if (request.params !== undefined) {
      let json: string | undefined;
      try {
        json = JSON.stringify(request.params);
      } catch {
        fail('INVALID_INPUT', 'Worker parameters are not serializable.');
      }
      if (json === undefined || bytes(json) > MAX_PARAMS_BYTES) {
        fail('INVALID_INPUT', 'Worker parameters exceed their bound.');
      }
    }
  }
  return parsed.data;
}

function parseReportInput(raw: unknown): RunReportInput {
  const parsed = RunReportInputSchema.safeParse(raw);
  if (!parsed.success) fail('INVALID_INPUT', 'The worker report input is invalid.');
  if (bytes(parsed.data.summary) > MAX_SUMMARY_BYTES) {
    fail('INVALID_INPUT', 'The worker report summary exceeds its bound.');
  }
  if (parsed.data.usage !== undefined && Object.keys(parsed.data.usage).length > 16) {
    fail('INVALID_INPUT', 'Worker usage metadata exceeds its bound.');
  }
  return parsed.data;
}

function parseStatusInput(raw: unknown): RunStatusInput {
  const parsed = RunStatusInputSchema.safeParse(raw);
  if (!parsed.success) fail('INVALID_INPUT', 'The run status input is invalid.');
  return parsed.data;
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

function requirePrincipal(actor: VerifiedActorAuthInfo): void {
  if (!validActor(actor) || actor.actorId !== 'codex' || actor.role !== 'principal'
    || !hasCapability(actor.capabilities, 'qa:request')) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot dispatch worker runs.');
  }
}

function requireWorkerReporter(actor: VerifiedActorAuthInfo): void {
  if (!validActor(actor) || actor.role !== 'worker' || !hasCapability(actor.capabilities, 'work:report')) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot report worker runs.');
  }
}

function requireReader(actor: VerifiedActorAuthInfo): void {
  if (!validActor(actor) || (actor.role !== 'principal' && actor.role !== 'observer')
    || !hasCapability(actor.capabilities, 'job:read')) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot read worker runs.');
  }
}

function hashRequest(input: QaDispatchInput): string {
  return createHash('sha256').update(JSON.stringify({
    operation: 'qa_dispatch',
    job_id: input.job_id,
    cycle: input.cycle,
    expected_version: input.expected_version,
    requests: input.requests.map((request) => ({
      worker_id: request.worker_id,
      task: request.task,
      params: request.params ?? null,
      timeout_ms: request.timeout_ms ?? null,
    })),
  }), 'utf8').digest('hex');
}

function storedDispatch(value: unknown): StoredDispatchResult {
  if (value === null || typeof value !== 'object') fail('INTERNAL_ERROR', 'The stored dispatch response is invalid.');
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['job_id'] !== 'string'
    || typeof candidate['cycle'] !== 'number'
    || !Number.isSafeInteger(candidate['cycle'])
    || candidate['cycle'] < 0
    || candidate['state'] !== 'QA_RUNNING'
    || typeof candidate['version'] !== 'number'
    || !Number.isSafeInteger(candidate['version'])
    || !Array.isArray(candidate['runs'])
  ) fail('INTERNAL_ERROR', 'The stored dispatch response is invalid.');
  const runs = candidate['runs'].map((run) => {
    if (run === null || typeof run !== 'object') fail('INTERNAL_ERROR', 'The stored dispatch response is invalid.');
    const row = run as Record<string, unknown>;
    if (typeof row['run_id'] !== 'string' || typeof row['worker_id'] !== 'string' || row['status'] !== 'PENDING') {
      fail('INTERNAL_ERROR', 'The stored dispatch response is invalid.');
    }
    return { run_id: row['run_id'], worker_id: row['worker_id'], status: 'PENDING' as const };
  });
  return {
    job_id: candidate['job_id'],
    cycle: candidate['cycle'],
    state: 'QA_RUNNING',
    version: candidate['version'],
    runs,
  };
}

function replayDispatch(
  db: SqliteDatabase,
  actorId: string,
  key: string | undefined,
  hash: string,
): DispatchPublicResult | undefined {
  if (key === undefined) return undefined;
  const row = db.prepare(
    'SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND key = ?',
  ).get(actorId, key) as IdempotencyRow | undefined;
  if (row === undefined) return undefined;
  if (String(row.request_hash) !== hash) fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different request.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.response_json)) as unknown;
  } catch {
    fail('INTERNAL_ERROR', 'The stored dispatch response is not valid JSON.');
  }
  return storedDispatch(parsed);
}

function loadJob(db: SqliteDatabase, jobId: string): JobRow {
  const row = db.prepare(
    'SELECT job_id, workspace, cycle, state, version, max_cycles, deadline_at FROM jobs WHERE job_id = ?',
  ).get(jobId) as JobRow | undefined;
  if (row === undefined) fail('JOB_NOT_FOUND', 'The requested job was not found.');
  return row;
}

function workerFor(registry: Phase6WorkerRegistry, workerId: string): WorkerDefinitionFile {
  const worker = registry.workers.find((candidate) => candidate.worker_id === workerId);
  if (worker === undefined) fail('WORKER_NOT_FOUND', 'The requested worker is not registered.');
  if (!worker.enabled) fail('WORKER_DISABLED', 'The requested worker is disabled.');
  return worker;
}

function normalizedParams(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value === undefined ? {} : { ...value };
}

function requestJson(
  request: QaDispatchInput['requests'][number],
  worker: WorkerDefinitionFile,
  timeoutMs: number,
): string {
  const serialized = JSON.stringify({
    task: request.task,
    params: normalizedParams(request.params),
    timeout_ms: timeoutMs,
    delivery: worker.delivery,
  });
  if (bytes(serialized) > MAX_PARAMS_BYTES + MAX_TASK_BYTES + 512) {
    fail('INVALID_INPUT', 'The normalized worker request exceeds its bound.');
  }
  return serialized;
}

function summaryFromSql(row: RunSqlRow): RunSummary {
  const status = String(row.status);
  if (!(RUN_STATUS_VALUES as readonly string[]).includes(status)) fail('INTERNAL_ERROR', 'The stored run status is invalid.');
  const verdict = row.worker_verdict === null ? null : String(row.worker_verdict);
  if (verdict !== null && !(WORKER_VERDICT_VALUES as readonly string[]).includes(verdict)) {
    fail('INTERNAL_ERROR', 'The stored worker verdict is invalid.');
  }
  const failureClass = row.failure_class === null ? null : String(row.failure_class);
  if (failureClass !== null && !(RUN_FAILURE_CLASS_VALUES as readonly string[]).includes(failureClass)) {
    fail('INTERNAL_ERROR', 'The stored run failure class is invalid.');
  }
  return {
    run_id: String(row.run_id),
    job_id: String(row.job_id),
    cycle: Number(row.cycle),
    worker_id: String(row.worker_id),
    status: status as RunStatus,
    worker_verdict: verdict as WorkerVerdict | null,
    failure_class: failureClass as RunFailureClass | null,
    attempt: Number(row.attempt),
    started_at: row.started_at === null ? null : String(row.started_at),
    ended_at: row.ended_at === null ? null : String(row.ended_at),
  };
}

function allRunsTerminal(db: SqliteDatabase, jobId: string, cycle: number): boolean {
  const row = db.prepare(
    "SELECT count(*) AS pending FROM worker_runs WHERE job_id = ? AND cycle = ? AND status IN ('PENDING', 'RUNNING')",
  ).get(jobId, cycle) as { readonly pending?: unknown };
  return Number(row.pending) === 0;
}

function settleJobIfComplete(
  db: SqliteDatabase,
  audit: AuditWriter,
  jobId: string,
  cycle: number,
  requestId: string,
  timestamp: string,
): string {
  const job = loadJob(db, jobId);
  if (job.state !== 'QA_RUNNING' || job.cycle !== cycle || !allRunsTerminal(db, jobId, cycle)) {
    return job.state;
  }
  const changed = db.prepare(
    "UPDATE jobs SET state = 'EVIDENCE_READY', state_reason = 'runs_settled', version = version + 1, updated_at = ? WHERE job_id = ? AND state = 'QA_RUNNING' AND cycle = ?",
  ).run(timestamp, jobId, cycle).changes;
  if (changed === 1) {
    audit.appendInTransaction({
      actorId: 'system',
      actorRole: 'system',
      requestId,
      action: 'system.runs_settled',
      jobId,
      cycle,
      fromState: 'QA_RUNNING',
      toState: 'EVIDENCE_READY',
      result: 'ok',
      timestamp,
    });
    return 'EVIDENCE_READY';
  }
  return loadJob(db, jobId).state;
}

function leaseMatches(row: LeaseSqlRow, payload: LeasePayload): boolean {
  return String(row.lease_id) === payload.lease_id
    && String(row.run_id) === payload.run_id
    && String(row.job_id) === payload.job_id
    && Number(row.cycle) === payload.cycle
    && String(row.actor_id) === payload.actor_id
    && String(row.nonce) === payload.nonce
    && String(row.expires_at) === payload.expires_at;
}

function runReportResponse(
  run: RunSummary,
  jobState: string,
  accepted: boolean,
  duplicate: boolean,
): ReportResult {
  return {
    run_id: run.run_id,
    job_id: run.job_id,
    cycle: run.cycle,
    status: run.status,
    accepted,
    duplicate,
    job_state: jobState,
  };
}

/** Atomically creates runs, leases, and the non-authoritative QA_RUNNING state. */
export function dispatchQa(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  rawInput: unknown,
  requestId: string,
  options: Phase6RunOptions,
): DispatchResult {
  requirePrincipal(actor);
  if (options.acceptingWork?.() === false) {
    fail('SERVICE_SHUTTING_DOWN', 'The service is shutting down and is not accepting new dispatches.');
  }
  const input = parseDispatchInput(rawInput);
  const hash = hashRequest(input);
  return withImmediateTransaction(db, () => {
    const replay = replayDispatch(db, actor.actorId, input.idempotency_key, hash);
    if (replay !== undefined) return { ...replay, runtimeLeases: [] };

    const job = loadJob(db, input.job_id);
    if (job.state !== 'IN_PROGRESS' && job.state !== 'REPAIR') {
      fail('STATE_CONFLICT', 'The job is not eligible for QA dispatch.');
    }
    if (job.cycle !== input.cycle || job.version !== input.expected_version) {
      fail('STATE_CONFLICT', 'The job cycle or version changed before dispatch.');
    }
    if (job.cycle >= job.max_cycles) fail('STATE_CONFLICT', 'The job has reached its cycle limit.');

    const ids = new Set<string>();
    const timestamp = nowIso(options);
    const runs: DispatchPublicResult['runs'][number][] = [];
    const runtimeLeases: DispatchResult['runtimeLeases'][number][] = [];
    for (const request of input.requests) {
      if (ids.has(request.worker_id)) fail('INVALID_INPUT', 'A worker may appear only once per dispatch.');
      ids.add(request.worker_id);
      const worker = workerFor(options.registry, request.worker_id);
      const timeout = request.timeout_ms ?? worker.default_timeout_ms;
      if (timeout > worker.hard_timeout_ms || timeout > MAX_LEASE_TIMEOUT_MS) {
        fail('INVALID_INPUT', 'The requested worker timeout exceeds its configured bound.');
      }
      const expiresAt = new Date((options.clock ?? (() => Date.now()))() + timeout).toISOString();
      const material = createLeaseMaterial(worker.actor_id, job.job_id, job.cycle, expiresAt, options.leaseKey);
      const serializedRequest = requestJson(request, worker, timeout);
      db.prepare(
        'INSERT INTO worker_runs(run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, exit_code, pid, usage_json, stderr_tail, attempt, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        material.runId,
        job.job_id,
        job.cycle,
        worker.worker_id,
        worker.adapter,
        serializedRequest,
        'PENDING',
        null,
        null,
        null,
        null,
        null,
        null,
        1,
        null,
        null,
        timestamp,
      );
      db.prepare(
        'INSERT INTO leases(lease_id, run_id, job_id, cycle, actor_id, nonce, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        material.leaseId,
        material.runId,
        job.job_id,
        job.cycle,
        worker.actor_id,
        material.nonce,
        expiresAt,
        null,
        timestamp,
      );
      runs.push({ run_id: material.runId, worker_id: worker.worker_id, status: 'PENDING' });
      runtimeLeases.push({ run_id: material.runId, lease: material.token, worker_id: worker.worker_id });
    }

    const changed = db.prepare(
      "UPDATE jobs SET state = 'QA_RUNNING', state_reason = 'qa_dispatch', version = version + 1, updated_at = ? WHERE job_id = ? AND state IN ('IN_PROGRESS', 'REPAIR') AND cycle = ? AND version = ?",
    ).run(timestamp, job.job_id, job.cycle, job.version).changes;
    if (changed !== 1) fail('STATE_CONFLICT', 'The job changed before QA dispatch could commit.');

    audit.appendInTransaction({
      actorId: actor.actorId,
      actorRole: actor.role,
      sessionTokenId: actor.tokenId,
      requestId,
      sessionHint: actor.sessionLabel,
      action: 'qa.dispatch',
      jobId: job.job_id,
      cycle: job.cycle,
      capability: 'qa:request',
      fromState: job.state,
      toState: 'QA_RUNNING',
      result: 'ok',
      detail: { run_count: runs.length, worker_ids: runs.map((run) => run.worker_id) },
      timestamp,
    });
    for (const run of runtimeLeases) {
      audit.appendInTransaction({
        actorId: actor.actorId,
        actorRole: actor.role,
        sessionTokenId: actor.tokenId,
        requestId,
        sessionHint: actor.sessionLabel,
        action: 'lease.issued',
        jobId: job.job_id,
        cycle: job.cycle,
        capability: 'qa:request',
        subjectType: 'run',
        subjectId: run.run_id,
        result: 'ok',
        detail: { worker_id: run.worker_id },
        timestamp,
      });
    }

    const publicResult: DispatchPublicResult = {
      job_id: job.job_id,
      cycle: job.cycle,
      state: 'QA_RUNNING',
      version: job.version + 1,
      runs,
    };
    if (input.idempotency_key !== undefined) {
      db.prepare(
        'INSERT INTO idempotency(actor_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(actor.actorId, input.idempotency_key, hash, JSON.stringify(publicResult), timestamp);
    }
    return { ...publicResult, runtimeLeases };
  });
}

/** Marks one admitted run active; this is runtime-owned and not an MCP tool. */
export function startRun(
  db: SqliteDatabase,
  audit: AuditWriter,
  runId: string,
  requestId: string,
  options: Phase6RunOptions,
): RunSummary {
  const timestamp = nowIso(options);
  return withImmediateTransaction(db, () => {
    const row = db.prepare(
      'SELECT run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, attempt, started_at, ended_at, created_at, pid, exit_code, usage_json FROM worker_runs WHERE run_id = ?',
    ).get(runId) as RunSqlRow | undefined;
    if (row === undefined) fail('RUN_NOT_FOUND', 'The requested run was not found.');
    const current = summaryFromSql(row);
    if (current.status === 'RUNNING') return current;
    if (current.status !== 'PENDING') fail('STATE_CONFLICT', 'The run is not pending.');
    const changed = db.prepare(
      "UPDATE worker_runs SET status = 'RUNNING', started_at = ? WHERE run_id = ? AND status = 'PENDING'",
    ).run(timestamp, runId).changes;
    if (changed !== 1) fail('STATE_CONFLICT', 'The run changed before it could start.');
    audit.appendInTransaction({
      actorId: 'system',
      actorRole: 'system',
      requestId,
      action: 'run.start',
      jobId: current.job_id,
      cycle: current.cycle,
      subjectType: 'run',
      subjectId: runId,
      fromState: 'PENDING',
      toState: 'RUNNING',
      result: 'ok',
      timestamp,
    });
    const updated = db.prepare(
      'SELECT run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, attempt, started_at, ended_at, created_at, pid, exit_code, usage_json FROM worker_runs WHERE run_id = ?',
    ).get(runId) as RunSqlRow;
    return summaryFromSql(updated);
  });
}

/** Records the child PID after the run has been atomically marked RUNNING. */
export function setRunPid(
  db: SqliteDatabase,
  runId: string,
  pid: number,
): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('INVALID_INPUT', 'The worker process ID is invalid.');
  const changed = db.prepare(
    "UPDATE worker_runs SET pid = ? WHERE run_id = ? AND status = 'RUNNING' AND pid IS NULL",
  ).run(pid, runId).changes;
  if (changed !== 1) fail('STATE_CONFLICT', 'The run is no longer available for a process ID.');
}

/** Stores only the bounded stderr tail owned by the process runtime. */
export function setRunStderr(
  db: SqliteDatabase,
  runId: string,
  stderr: string,
): void {
  if (bytes(stderr) > 65_536) fail('INVALID_INPUT', 'The worker stderr tail exceeds its bound.');
  db.prepare(
    "UPDATE worker_runs SET stderr_tail = ? WHERE run_id = ? AND status IN ('RUNNING', 'PENDING')",
  ).run(stderr, runId);
}

function settleRun(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo | undefined,
  payload: LeasePayload,
  requestId: string,
  status: Extract<RunStatus, 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'MALFORMED'>,
  verdict: WorkerVerdict | null,
  failureClass: RunFailureClass | null,
  summary: string | null,
  usage: Record<string, number> | undefined,
  exitCode: number | null,
  options: Phase6RunOptions,
  allowExpired: boolean,
  secretValues: readonly string[] = [],
): ReportResult {
  const timestamp = nowIso(options);
  return withImmediateTransaction(db, () => {
    const row = db.prepare(
      'SELECT lease_id, run_id, job_id, cycle, actor_id, nonce, expires_at, consumed_at FROM leases WHERE lease_id = ?',
    ).get(payload.lease_id) as LeaseSqlRow | undefined;
    if (row === undefined || !leaseMatches(row, payload)) fail('LEASE_REJECTED', 'The run lease is not valid for this run.');
    if (actor !== undefined && payload.actor_id !== actor.actorId) {
      fail('LEASE_REJECTED', 'The run lease belongs to another worker.');
    }

    const runRow = db.prepare(
      'SELECT run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, attempt, started_at, ended_at, created_at, pid, exit_code, usage_json FROM worker_runs WHERE run_id = ?',
    ).get(payload.run_id) as RunSqlRow | undefined;
    if (runRow === undefined) fail('RUN_NOT_FOUND', 'The requested run was not found.');
    const current = summaryFromSql(runRow);
    const job = loadJob(db, payload.job_id);

    if (row.consumed_at !== null) {
      if (!(RUN_TERMINAL_STATUS_VALUES as readonly string[]).includes(current.status)) {
        fail('STATE_CONFLICT', 'The consumed lease has a non-terminal run.');
      }
      if (actor !== undefined) {
        audit.appendInTransaction({
          actorId: actor.actorId,
          actorRole: actor.role,
          sessionTokenId: actor.tokenId,
          requestId,
          sessionHint: actor.sessionLabel,
          action: 'run.duplicate_rejected',
          jobId: current.job_id,
          cycle: current.cycle,
          subjectType: 'run',
          subjectId: current.run_id,
          result: 'ok',
          detail: { status: current.status },
          timestamp,
        });
      }
      return runReportResponse(current, job.state, false, true);
    }

    if (!allowExpired && Date.parse(String(row.expires_at)) <= (options.clock ?? (() => Date.now()))()) {
      if (actor !== undefined) {
        audit.appendInTransaction({
          actorId: actor.actorId,
          actorRole: actor.role,
          sessionTokenId: actor.tokenId,
          requestId,
          sessionHint: actor.sessionLabel,
          action: 'lease.rejected',
          jobId: current.job_id,
          cycle: current.cycle,
          subjectType: 'run',
          subjectId: current.run_id,
          result: 'denied',
          detail: { reason: 'expired' },
          timestamp,
        });
      }
      fail('LEASE_REJECTED', 'The run lease has expired.');
    }
    if (current.status !== 'PENDING' && current.status !== 'RUNNING') {
      fail('STATE_CONFLICT', 'The run is not active.');
    }
    if (job.job_id !== payload.job_id || job.cycle !== payload.cycle) {
      fail('LEASE_REJECTED', 'The run lease does not match the current job cycle.');
    }
    if (actor !== undefined && job.state !== 'QA_RUNNING') {
      fail('STATE_CONFLICT', 'The job is no longer accepting worker reports.');
    }

    const consumed = db.prepare(
      'UPDATE leases SET consumed_at = ? WHERE lease_id = ? AND consumed_at IS NULL',
    ).run(timestamp, payload.lease_id).changes;
    if (consumed !== 1) fail('STATE_CONFLICT', 'The run lease changed before settlement.');

    const startedAt = current.started_at ?? timestamp;
    const usageJson = usage === undefined ? null : JSON.stringify(usage);
    const changed = db.prepare(
      'UPDATE worker_runs SET status = ?, worker_verdict = ?, failure_class = ?, exit_code = ?, usage_json = ?, started_at = ?, ended_at = ? WHERE run_id = ? AND status IN (\'PENDING\', \'RUNNING\')',
    ).run(status, verdict, failureClass, exitCode, usageJson, startedAt, timestamp, payload.run_id).changes;
    if (changed !== 1) fail('STATE_CONFLICT', 'The run changed before settlement.');

    const auditAction = status === 'TIMEOUT'
      ? 'run.timeout'
      : status === 'CANCELLED'
        ? 'run.cancelled'
        : status === 'FAILED' || status === 'MALFORMED'
          ? 'run.failed'
          : 'run.report';
    audit.appendInTransaction({
      actorId: actor?.actorId ?? 'system',
      actorRole: actor?.role ?? 'system',
      sessionTokenId: actor?.tokenId ?? null,
      requestId,
      sessionHint: actor?.sessionLabel ?? null,
      action: auditAction,
      jobId: current.job_id,
      cycle: current.cycle,
      capability: actor === undefined ? null : 'work:report',
      subjectType: 'run',
      subjectId: current.run_id,
      result: 'ok',
      detail: {
        ...(summary === null ? {} : { summary }),
        ...(failureClass === null ? {} : { failure_class: failureClass }),
      },
      secretValues,
      timestamp,
    });
    audit.appendInTransaction({
      actorId: actor?.actorId ?? 'system',
      actorRole: actor?.role ?? 'system',
      sessionTokenId: actor?.tokenId ?? null,
      requestId,
      sessionHint: actor?.sessionLabel ?? null,
      action: 'lease.consumed',
      jobId: current.job_id,
      cycle: current.cycle,
      capability: actor === undefined ? null : 'work:report',
      subjectType: 'run',
      subjectId: current.run_id,
      result: 'ok',
      secretValues,
      timestamp,
    });
    const jobState = settleJobIfComplete(db, audit, current.job_id, current.cycle, requestId, timestamp);
    const updated = db.prepare(
      'SELECT run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, attempt, started_at, ended_at, created_at, pid, exit_code, usage_json FROM worker_runs WHERE run_id = ?',
    ).get(payload.run_id) as RunSqlRow;
    return runReportResponse(summaryFromSql(updated), jobState, true, false);
  });
}

/** Accepts one worker terminal report after validating its actor and lease. */
export function reportRun(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  rawInput: unknown,
  requestId: string,
  options: Phase6RunOptions,
): ReportResult {
  requireWorkerReporter(actor);
  const input = parseReportInput(rawInput);
  let payload: LeasePayload;
  try {
    payload = verifyLease(input.lease, options.leaseKey, (options.clock ?? (() => Date.now()))());
  } catch (cause) {
    if (cause instanceof LeaseError) fail('LEASE_REJECTED', cause.message);
    fail('LEASE_REJECTED', 'The run lease is invalid.');
  }
  return settleRun(
    db,
    audit,
    actor,
    payload,
    requestId,
    'SUCCEEDED',
    input.verdict,
    null,
    safeWorkerText(input.summary, [input.lease]),
    input.usage,
    0,
    options,
    false,
    [input.lease],
  );
}

/** Settles a process-owned terminal outcome; expired leases remain settleable by the runtime. */
export function settleRuntimeRun(
  db: SqliteDatabase,
  audit: AuditWriter,
  lease: string,
  requestId: string,
  status: Extract<RunStatus, 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'MALFORMED'>,
  verdict: WorkerVerdict | null,
  failureClass: RunFailureClass | null,
  summary: string | null,
  usage: Record<string, number> | undefined,
  exitCode: number | null,
  options: Phase6RunOptions,
): ReportResult {
  let payload: LeasePayload;
  try {
    payload = verifyLease(lease, options.leaseKey, (options.clock ?? (() => Date.now()))(), { allowExpired: true });
  } catch {
    fail('LEASE_REJECTED', 'The runtime lease is invalid.');
  }
  return settleRun(
    db,
    audit,
    undefined,
    payload,
    requestId,
    status,
    verdict,
    failureClass,
    summary === null ? null : safeWorkerText(summary, [lease]),
    usage,
    exitCode,
    options,
    true,
    [lease],
  );
}

/** Cancels active runs after the existing Codex CANCEL decision commits. */
export function cancelRunsForJob(
  db: SqliteDatabase,
  audit: AuditWriter,
  jobId: string,
  requestId: string,
  options: Phase6RunOptions,
): readonly string[] {
  const timestamp = nowIso(options);
  return withImmediateTransaction(db, () => {
    const rows = db.prepare(
      "SELECT run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, attempt, started_at, ended_at, created_at, pid, exit_code, usage_json FROM worker_runs WHERE job_id = ? AND status IN ('PENDING', 'RUNNING') ORDER BY run_id",
    ).all(jobId) as RunSqlRow[];
    const cancelled: string[] = [];
    for (const row of rows) {
      const run = summaryFromSql(row);
      const changed = db.prepare(
        "UPDATE worker_runs SET status = 'CANCELLED', worker_verdict = 'NONE', ended_at = ? WHERE run_id = ? AND status IN ('PENDING', 'RUNNING')",
      ).run(timestamp, run.run_id).changes;
      if (changed !== 1) continue;
      const leaseChanged = db.prepare(
        'UPDATE leases SET consumed_at = ? WHERE run_id = ? AND consumed_at IS NULL',
      ).run(timestamp, run.run_id).changes;
      audit.appendInTransaction({
        actorId: 'system',
        actorRole: 'system',
        requestId,
        action: 'run.cancelled',
        jobId,
        cycle: run.cycle,
        subjectType: 'run',
        subjectId: run.run_id,
        result: 'ok',
        timestamp,
      });
      if (leaseChanged === 1) {
        audit.appendInTransaction({
          actorId: 'system',
          actorRole: 'system',
          requestId,
          action: 'lease.consumed',
          jobId,
          cycle: run.cycle,
          subjectType: 'run',
          subjectId: run.run_id,
          result: 'ok',
          detail: { reason: 'cancelled' },
          timestamp,
        });
      }
      cancelled.push(run.run_id);
    }
    return cancelled;
  });
}

/** Reads bounded run metadata for a principal or observer. */
export function listRunStatus(
  db: SqliteDatabase,
  actor: VerifiedActorAuthInfo,
  rawInput: unknown,
): readonly RunSummary[] {
  requireReader(actor);
  const input = parseStatusInput(rawInput);
  const job = loadJob(db, input.job_id);
  if (input.run_id !== undefined) {
    const row = db.prepare(
      'SELECT run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, attempt, started_at, ended_at, created_at, pid, exit_code, usage_json FROM worker_runs WHERE job_id = ? AND run_id = ?',
    ).get(input.job_id, input.run_id) as RunSqlRow | undefined;
    if (row === undefined) fail('RUN_NOT_FOUND', 'The requested run was not found.');
    if (input.cycle !== undefined && Number(row.cycle) !== input.cycle) return [];
    return [summaryFromSql(row)];
  }
  const rows = input.cycle === undefined
    ? db.prepare(
      'SELECT run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, attempt, started_at, ended_at, created_at, pid, exit_code, usage_json FROM worker_runs WHERE job_id = ? ORDER BY cycle, created_at, run_id LIMIT 256',
    ).all(job.job_id) as RunSqlRow[]
    : db.prepare(
      'SELECT run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, attempt, started_at, ended_at, created_at, pid, exit_code, usage_json FROM worker_runs WHERE job_id = ? AND cycle = ? ORDER BY created_at, run_id',
    ).all(job.job_id, input.cycle) as RunSqlRow[];
  return rows.map(summaryFromSql);
}

/** Loads runtime-only data for the process adapter without exposing it through MCP. */
export function loadRunForRuntime(
  db: SqliteDatabase,
  runId: string,
): {
  readonly run: RunSummary;
  readonly workspace: string;
  readonly deadline_at: string | null;
  readonly request: { readonly task: string; readonly params: Record<string, unknown>; readonly timeout_ms: number; readonly delivery: 'pipe' | 'mcp_pull' };
} {
  const row = db.prepare(
    'SELECT wr.run_id, wr.job_id, wr.cycle, wr.worker_id, wr.adapter, wr.request_json, wr.status, wr.worker_verdict, wr.failure_class, wr.attempt, wr.started_at, wr.ended_at, wr.created_at, wr.pid, wr.exit_code, wr.usage_json, j.workspace, j.state AS job_state, j.deadline_at FROM worker_runs wr JOIN jobs j ON j.job_id = wr.job_id WHERE wr.run_id = ?',
  ).get(runId) as RunSqlRow | undefined;
  if (row === undefined) fail('RUN_NOT_FOUND', 'The requested run was not found.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.request_json)) as unknown;
  } catch {
    fail('INTERNAL_ERROR', 'The stored worker request is invalid.');
  }
  if (parsed === null || typeof parsed !== 'object') fail('INTERNAL_ERROR', 'The stored worker request is invalid.');
  const request = parsed as Record<string, unknown>;
  if (typeof request['task'] !== 'string' || typeof request['params'] !== 'object' || request['params'] === null
    || Array.isArray(request['params'])
    || typeof request['timeout_ms'] !== 'number' || (request['delivery'] !== 'pipe' && request['delivery'] !== 'mcp_pull')) {
    fail('INTERNAL_ERROR', 'The stored worker request is invalid.');
  }
  return {
    run: summaryFromSql(row),
    workspace: String(row.workspace),
    deadline_at: row.deadline_at === null || row.deadline_at === undefined ? null : String(row.deadline_at),
    request: {
      task: request['task'],
      params: request['params'] as Record<string, unknown>,
      timeout_ms: request['timeout_ms'],
      delivery: request['delivery'],
    },
  };
}

export function renderWorkerArguments(
  worker: WorkerDefinitionFile,
  run: RunSummary,
): readonly string[] {
  const substitutions: Record<string, string> = {
    '{run_id}': run.run_id,
    '{job_id}': run.job_id,
    '{cycle}': String(run.cycle),
  };
  return worker.argv_template.map((argument) => {
    let rendered = argument;
    for (const [placeholder, value] of Object.entries(substitutions)) {
      rendered = rendered.split(placeholder).join(value);
    }
    const unknownPlaceholder = /\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rendered);
    if (unknownPlaceholder !== null) {
      fail('INVALID_INPUT', 'The worker argv template contains an unknown placeholder.');
    }
    return rendered;
  });
}
