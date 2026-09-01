import { randomUUID } from 'node:crypto';

import type { AuditWriter } from '../authority/audit.js';
import type { SqliteDatabase } from '../store/db.js';
import { withImmediateTransaction } from '../store/db.js';

const MAX_RECOVERY_BATCH = 100;
const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000;
const MAX_SHUTDOWN_DRAIN_MS = 30_000;
const RECOVERY_JOB_STATES = new Set(['IN_PROGRESS', 'QA_RUNNING', 'REPAIR', 'PACKAGING']);
type ActiveRunStatus = 'PENDING' | 'RUNNING';

export const RECOVERY_BATCH_SIZE = MAX_RECOVERY_BATCH;
export const REAPER_INTERVAL_MS = DEFAULT_REAPER_INTERVAL_MS;
export const SHUTDOWN_DRAIN_MS = DEFAULT_SHUTDOWN_DRAIN_MS;
export const SHUTDOWN_MAX_DRAIN_MS = MAX_SHUTDOWN_DRAIN_MS;

export type RecoveryRunOutcome = 'ORPHANED' | 'TIMEOUT' | 'CANCELLED';
export type RecoveryReason =
  | 'startup_orphan'
  | 'runtime_ownership_lost'
  | 'lease_missing'
  | 'lease_expired'
  | 'deadline'
  | 'stale'
  | 'shutdown_interruption'
  | 'cancellation_cleanup';

export interface RecoverySummary {
  readonly examined: number;
  readonly reconciledRunIds: readonly string[];
  readonly stalledJobIds: readonly string[];
}

export interface RecoveryOptions {
  readonly clock?: () => number;
  readonly batchSize?: number;
  readonly requestId?: () => string;
  readonly reason?: RecoveryReason;
}

export interface ReaperOptions extends RecoveryOptions {
  readonly ownedRunIds: ReadonlySet<string>;
  readonly onReconciled?: (runId: string, outcome: RecoveryRunOutcome) => void;
}

export interface Phase8ProcessRuntime {
  readonly activeRunIds: () => readonly string[];
  readonly close: () => void;
  readonly waitForIdle: (timeoutMs: number) => Promise<boolean>;
  readonly stopRun: (runId: string, outcome: RecoveryRunOutcome) => void;
}

export interface Phase8LifecycleOptions {
  readonly db: SqliteDatabase;
  readonly audit: AuditWriter;
  readonly clock?: () => number;
  readonly reaperIntervalMs?: number;
  readonly shutdownDrainMs?: number;
  readonly getOwnedRunIds: () => ReadonlySet<string>;
  readonly onReconciled?: (runId: string, outcome: RecoveryRunOutcome) => void;
  readonly onReaperError?: (message: string) => void;
}

export class RecoveryError extends Error {
  public override readonly name = 'RecoveryError';
}

interface ActiveRunRow {
  readonly run_id: unknown;
  readonly job_id: unknown;
  readonly cycle: unknown;
  readonly status: unknown;
  readonly job_state: unknown;
  readonly job_cycle: unknown;
  readonly deadline_at: unknown;
  readonly lease_expires_at: unknown;
  readonly job_updated_at: unknown;
  readonly stale_after_s: unknown;
}

interface ReconciledRun {
  readonly runId: string;
  readonly jobId: string;
  readonly cycle: number;
  readonly outcome: RecoveryRunOutcome;
  readonly stalled: boolean;
}

function fail(message: string): never {
  throw new RecoveryError(message);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\0\r\n]/.test(value)) {
    fail('The recovery ' + field + ' is invalid.');
  }
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('The recovery ' + field + ' is invalid.');
  }
  return value as number;
}

function timestamp(value: unknown, field: string, allowNull = false): string | null {
  if (value === null && allowNull) return null;
  const parsed = text(value, field);
  if (!Number.isFinite(Date.parse(parsed))) fail('The recovery ' + field + ' is not a valid timestamp.');
  return parsed;
}

function nowIso(options: RecoveryOptions): string {
  return new Date((options.clock ?? (() => Date.now()))()).toISOString();
}

function requestId(options: RecoveryOptions): string {
  const candidate = options.requestId?.() ?? `phase8-recovery-${randomUUID()}`;
  if (candidate.trim() === '' || candidate.length > 256 || /[\r\n]/.test(candidate)) {
    fail('The recovery request identifier is invalid.');
  }
  return candidate;
}

function batchSize(options: RecoveryOptions): number {
  const value = options.batchSize ?? MAX_RECOVERY_BATCH;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECOVERY_BATCH) {
    fail('The recovery batch size exceeds its bound.');
  }
  return value;
}

function activeRunRows(db: SqliteDatabase, limit: number): ActiveRunRow[] {
  return db.prepare(
    `SELECT wr.run_id, wr.job_id, wr.cycle, wr.status,
            j.state AS job_state, j.cycle AS job_cycle, j.deadline_at,
            j.updated_at AS job_updated_at, j.stale_after_s,
            l.expires_at AS lease_expires_at
       FROM worker_runs wr
       JOIN jobs j ON j.job_id = wr.job_id
       LEFT JOIN leases l ON l.run_id = wr.run_id
      WHERE wr.status IN ('PENDING', 'RUNNING')
      ORDER BY wr.created_at, wr.run_id
      LIMIT ?`,
  ).all(limit) as ActiveRunRow[];
}

function validateActiveRunRow(row: ActiveRunRow): {
  readonly runId: string;
  readonly jobId: string;
  readonly cycle: number;
  readonly status: ActiveRunStatus;
  readonly jobState: string;
  readonly jobCycle: number;
  readonly deadlineAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly jobUpdatedAt: string;
  readonly staleAfterS: number;
} {
  const runId = text(row.run_id, 'run identifier');
  const jobId = text(row.job_id, 'job identifier');
  const cycle = nonnegativeInteger(row.cycle, 'run cycle');
  if (row.status !== 'PENDING' && row.status !== 'RUNNING') fail('The recovery run status is not active.');
  const jobState = text(row.job_state, 'job state');
  const jobCycle = nonnegativeInteger(row.job_cycle, 'job cycle');
  const deadlineAt = timestamp(row.deadline_at, 'job deadline', true);
  const leaseExpiresAt = timestamp(row.lease_expires_at, 'lease expiry', true);
  const jobUpdatedAt = timestamp(row.job_updated_at, 'job updated_at');
  if (jobUpdatedAt === null) fail('The recovery job updated_at is missing.');
  const staleAfterS = nonnegativeInteger(row.stale_after_s, 'stale_after_s');
  return {
    runId,
    jobId,
    cycle,
    status: row.status,
    jobState,
    jobCycle,
    deadlineAt,
    leaseExpiresAt,
    jobUpdatedAt,
    staleAfterS,
  };
}

function reconcileRunInTransaction(
  db: SqliteDatabase,
  audit: AuditWriter,
  runId: string,
  outcome: RecoveryRunOutcome,
  reason: RecoveryReason,
  options: RecoveryOptions,
): ReconciledRun | undefined {
  const row = db.prepare(
    `SELECT wr.run_id, wr.job_id, wr.cycle, wr.status,
            j.state AS job_state, j.cycle AS job_cycle
       FROM worker_runs wr
       JOIN jobs j ON j.job_id = wr.job_id
      WHERE wr.run_id = ?`,
  ).get(runId) as Pick<ActiveRunRow, 'run_id' | 'job_id' | 'cycle' | 'status' | 'job_state' | 'job_cycle'> | undefined;
  if (row === undefined) return undefined;
  const currentRunId = text(row.run_id, 'run identifier');
  if (row.status !== 'PENDING' && row.status !== 'RUNNING') return undefined;
  const jobId = text(row.job_id, 'job identifier');
  const cycle = nonnegativeInteger(row.cycle, 'run cycle');
  const jobState = text(row.job_state, 'job state');
  const jobCycle = nonnegativeInteger(row.job_cycle, 'job cycle');
  const timestampValue = nowIso(options);
  const status = outcome;
  const failureClass = outcome === 'TIMEOUT' ? 'TIMEOUT' : null;
  const changed = db.prepare(
    `UPDATE worker_runs
        SET status = ?, worker_verdict = 'NONE', failure_class = ?, ended_at = ?
      WHERE run_id = ? AND status IN ('PENDING', 'RUNNING')`,
  ).run(status, failureClass, timestampValue, currentRunId).changes;
  if (changed !== 1) return undefined;

  audit.appendInTransaction({
    actorId: 'system',
    actorRole: 'system',
    requestId: requestId(options),
    action: outcome === 'ORPHANED'
      ? 'run.orphaned'
      : outcome === 'TIMEOUT'
        ? 'run.timeout'
        : 'run.cancelled',
    jobId,
    cycle,
    subjectType: 'run',
    subjectId: currentRunId,
    fromState: row.status,
    toState: outcome,
    result: 'ok',
    detail: { reason },
    timestamp: timestampValue,
  });

  let stalled = false;
  if (RECOVERY_JOB_STATES.has(jobState) && jobCycle === cycle) {
    const stalledChange = db.prepare(
      `UPDATE jobs
        SET state = 'STALLED', state_reason = ?, version = version + 1, updated_at = ?
        WHERE job_id = ? AND state = ? AND cycle = ?
          AND authoritative_status IS NULL`,
    ).run(reason, timestampValue, jobId, jobState, cycle).changes;
    if (stalledChange === 1) {
      stalled = true;
      audit.appendInTransaction({
        actorId: 'system',
        actorRole: 'system',
        requestId: requestId(options),
        action: 'system.stall',
        jobId,
        cycle,
        subjectType: 'job',
        subjectId: jobId,
        fromState: jobState,
        toState: 'STALLED',
        result: 'ok',
        detail: { reason, run_id: currentRunId },
        timestamp: timestampValue,
      });
    }
  }
  return { runId: currentRunId, jobId, cycle, outcome, stalled };
}

function mergeSummary(
  target: { examined: number; reconciledRunIds: string[]; stalledJobIds: Set<string> },
  result: ReconciledRun | undefined,
): void {
  if (result === undefined) return;
  target.reconciledRunIds.push(result.runId);
  if (result.stalled) target.stalledJobIds.add(result.jobId);
}

function summaryOf(target: { examined: number; reconciledRunIds: string[]; stalledJobIds: Set<string> }): RecoverySummary {
  return {
    examined: target.examined,
    reconciledRunIds: [...target.reconciledRunIds],
    stalledJobIds: [...target.stalledJobIds],
  };
}

function startupOutcome(row: ReturnType<typeof validateActiveRunRow>): {
  readonly outcome: RecoveryRunOutcome;
  readonly reason: RecoveryReason;
} {
  return row.jobState === 'JOB_CANCELLED'
    ? { outcome: 'CANCELLED', reason: 'cancellation_cleanup' }
    : { outcome: 'ORPHANED', reason: 'startup_orphan' };
}

/** Reconciles every durable active run before a new transport is exposed. */
export function recoverOrphanedRuns(
  db: SqliteDatabase,
  audit: AuditWriter,
  options: RecoveryOptions = {},
): RecoverySummary {
  const result = { examined: 0, reconciledRunIds: [] as string[], stalledJobIds: new Set<string>() };
  const limit = batchSize(options);
  const configuredReason = options.reason;
  for (;;) {
    const batch = withImmediateTransaction(db, () => {
      const rows = activeRunRows(db, limit);
      for (const raw of rows) {
        const current = validateActiveRunRow(raw);
        result.examined += 1;
        const startup = startupOutcome(current);
        mergeSummary(
          result,
          reconcileRunInTransaction(
            db,
            audit,
            current.runId,
            startup.outcome,
            startup.outcome === 'CANCELLED' ? startup.reason : configuredReason ?? startup.reason,
            options,
          ),
        );
      }
      return rows.length;
    });
    if (batch === 0) break;
  }
  return summaryOf(result);
}

function reaperOutcome(
  row: ReturnType<typeof validateActiveRunRow>,
  nowMs: number,
  ownedRunIds: ReadonlySet<string>,
): { readonly outcome: RecoveryRunOutcome; readonly reason: RecoveryReason } | undefined {
  if (row.jobState === 'JOB_CANCELLED') {
    return { outcome: 'CANCELLED', reason: 'cancellation_cleanup' };
  }
  if (!ownedRunIds.has(row.runId)) {
    return { outcome: 'ORPHANED', reason: 'runtime_ownership_lost' };
  }
  if (row.leaseExpiresAt === null) return { outcome: 'ORPHANED', reason: 'lease_missing' };
  if (Date.parse(row.leaseExpiresAt) <= nowMs) return { outcome: 'TIMEOUT', reason: 'lease_expired' };
  if (row.deadlineAt !== null && Date.parse(row.deadlineAt) <= nowMs) {
    return { outcome: 'TIMEOUT', reason: 'deadline' };
  }
  if (RECOVERY_JOB_STATES.has(row.jobState)) {
    const staleAt = Date.parse(row.jobUpdatedAt) + row.staleAfterS * 1_000;
    if (staleAt <= nowMs) return { outcome: 'TIMEOUT', reason: 'stale' };
  }
  return undefined;
}

/** Performs one bounded reaper pass; candidates beyond the batch wait for the next pass. */
export function reapStaleRuns(
  db: SqliteDatabase,
  audit: AuditWriter,
  options: ReaperOptions,
): RecoverySummary {
  const result = { examined: 0, reconciledRunIds: [] as string[], stalledJobIds: new Set<string>() };
  const reconciledRuns: ReconciledRun[] = [];
  const limit = batchSize(options);
  const nowMs = (options.clock ?? (() => Date.now()))();
  if (!Number.isFinite(nowMs)) fail('The recovery clock is invalid.');
  withImmediateTransaction(db, () => {
    const rows = activeRunRows(db, limit);
    result.examined = rows.length;
    for (const raw of rows) {
      const current = validateActiveRunRow(raw);
      const candidate = reaperOutcome(current, nowMs, options.ownedRunIds);
      if (candidate === undefined) continue;
      const reconciledRun = reconcileRunInTransaction(
        db,
        audit,
        current.runId,
        candidate.outcome,
        candidate.reason,
        options,
      );
      mergeSummary(result, reconciledRun);
      if (reconciledRun !== undefined) reconciledRuns.push(reconciledRun);
    }
  });
  for (const run of reconciledRuns) options.onReconciled?.(run.runId, run.outcome);
  return summaryOf(result);
}

/** Owns the per-process reaper and the bounded shutdown/reconciliation sequence. */
export class Phase8Lifecycle {
  private readonly clock: () => number;
  private readonly reaperIntervalMs: number;
  private readonly shutdownDrainMs: number;
  private timer: NodeJS.Timeout | undefined;
  private reaping = false;
  private shuttingDown = false;
  private closed = false;
  private shutdownPromise: Promise<RecoverySummary> | undefined;

  public constructor(private readonly options: Phase8LifecycleOptions) {
    this.clock = options.clock ?? (() => Date.now());
    const interval = options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 1_000) {
      fail('The reaper interval is invalid.');
    }
    this.reaperIntervalMs = interval;
    const drain = options.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
    if (!Number.isSafeInteger(drain) || drain < 0 || drain > MAX_SHUTDOWN_DRAIN_MS) {
      fail('The shutdown drain interval exceeds its bound.');
    }
    this.shutdownDrainMs = drain;
  }

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Starts one bounded timer; startup recovery must have completed before this call. */
  public start(): void {
    if (this.closed || this.shuttingDown) fail('The Phase 8 lifecycle is closed.');
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      if (this.reaping || this.shuttingDown || this.closed) return;
      this.reaping = true;
      try {
        this.reapOnce();
      } catch {
        this.options.onReaperError?.('Phase 8 reaper reconciliation failed.');
      } finally {
        this.reaping = false;
      }
    }, this.reaperIntervalMs);
    this.timer.unref?.();
  }

  public reapOnce(): RecoverySummary {
    if (this.closed || this.shuttingDown) {
      return { examined: 0, reconciledRunIds: [], stalledJobIds: [] };
    }
    const reaperOptions: ReaperOptions = this.options.onReconciled === undefined
      ? {
        clock: this.clock,
        ownedRunIds: new Set(this.options.getOwnedRunIds()),
      }
      : {
        clock: this.clock,
        ownedRunIds: new Set(this.options.getOwnedRunIds()),
        onReconciled: this.options.onReconciled,
      };
    return reapStaleRuns(this.options.db, this.options.audit, reaperOptions);
  }

  public shutdown(processRuntime: Phase8ProcessRuntime): Promise<RecoverySummary> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.shutdownPromise = (async () => {
      processRuntime.close();
      await processRuntime.waitForIdle(this.shutdownDrainMs);
      const result = recoverOrphanedRuns(this.options.db, this.options.audit, {
        clock: this.clock,
        reason: 'shutdown_interruption',
      });
      this.closed = true;
      return result;
    })();
    return this.shutdownPromise;
  }
}
