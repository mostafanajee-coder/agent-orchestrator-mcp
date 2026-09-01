import { assertRoleCapabilities, parseCapabilities, type Capability } from '../authority/capabilities.js';
import type { SqliteDatabase } from '../store/db.js';
import { LeaseError, verifyLease, type LeasePayload } from '../workers/lease.js';

export interface WorkerLeaseOptions {
  readonly leaseKey: Buffer;
  readonly clock?: () => number;
  /** Internal process settlement may persist already-produced output after a timeout. */
  readonly allowExpired?: boolean;
}

export interface ActiveWorkerLease {
  readonly payload: LeasePayload;
  readonly actorId: string;
  readonly capabilities: readonly Capability[];
  readonly workspace: string;
}

export class WorkerLeaseBindingError extends Error {
  public override readonly name = 'WorkerLeaseBindingError';
}

function now(options: WorkerLeaseOptions): number {
  return (options.clock ?? (() => Date.now()))();
}

/** Verifies both the signed lease envelope and its current database binding. */
export function requireActiveWorkerLease(
  db: SqliteDatabase,
  lease: string,
  expectedActorId: string | undefined,
  options: WorkerLeaseOptions,
): ActiveWorkerLease {
  let payload: LeasePayload;
  try {
    payload = verifyLease(lease, options.leaseKey, now(options), { allowExpired: options.allowExpired === true });
  } catch (cause) {
    throw new WorkerLeaseBindingError(
      cause instanceof LeaseError ? cause.message : 'The worker lease is invalid.',
    );
  }

  const row = db.prepare(
    `SELECT l.lease_id, l.run_id, l.job_id, l.cycle, l.actor_id, l.expires_at, l.consumed_at,
            wr.status AS run_status, j.state AS job_state, j.workspace,
            a.role, a.disabled, a.capabilities_json
       FROM leases l
       JOIN worker_runs wr ON wr.run_id = l.run_id
       JOIN jobs j ON j.job_id = l.job_id
       JOIN actors a ON a.actor_id = l.actor_id
      WHERE l.lease_id = ? AND wr.job_id = l.job_id AND wr.cycle = l.cycle`,
  ).get(payload.lease_id) as Record<string, unknown> | undefined;

  if (row === undefined
    || String(row['run_id']) !== payload.run_id
    || String(row['job_id']) !== payload.job_id
    || Number(row['cycle']) !== payload.cycle
    || String(row['actor_id']) !== payload.actor_id
    || row['consumed_at'] !== null
    || String(row['run_status']) !== 'PENDING' && String(row['run_status']) !== 'RUNNING'
    || String(row['job_state']) !== 'QA_RUNNING'
    || (options.allowExpired !== true && Date.parse(String(row['expires_at'])) <= now(options))) {
    throw new WorkerLeaseBindingError('The worker lease is not active for this run.');
  }

  if (expectedActorId !== undefined && expectedActorId !== payload.actor_id) {
    throw new WorkerLeaseBindingError('The worker lease belongs to another actor.');
  }
  if (row['role'] !== 'worker' || Number(row['disabled']) !== 0
    || typeof row['capabilities_json'] !== 'string') {
    throw new WorkerLeaseBindingError('The worker actor is not enabled.');
  }

  let capabilities: Capability[];
  try {
    capabilities = parseCapabilities(row['capabilities_json']);
    assertRoleCapabilities('worker', capabilities);
  } catch {
    throw new WorkerLeaseBindingError('The worker actor capabilities are invalid.');
  }

  return {
    payload,
    actorId: payload.actor_id,
    capabilities,
    workspace: String(row['workspace']),
  };
}
