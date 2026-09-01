import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';

import type { SqliteDatabase } from '../store/db.js';
import { withImmediateTransaction } from '../store/db.js';
import type { VerifiedActorAuthInfo } from '../mcp/auth.js';

import { assertRoleCapabilities, canonicalCapabilitiesJson, hasCapability } from '../authority/capabilities.js';
import type { Capability } from '../authority/capabilities.js';
import type { AuditWriter } from '../authority/audit.js';
import {
  createManifestFile,
  MAX_ARTIFACT_BYTES,
  MAX_JOB_ARTIFACT_BYTES,
  MAX_JOB_ARTIFACT_ROWS,
  verifyArtifactFile,
} from './artifacts.js';

export const DECISION_VALUES = [
  'APPROVE',
  'REJECT',
  'FIX',
  'RETEST',
  'VERIFY_SELF',
  'IGNORE_FALSE_POSITIVE',
  'STOP',
  'PACKAGE',
  'DELIVER',
  'COMPLETE',
  'CANCEL',
] as const;

export type DecisionKind = (typeof DECISION_VALUES)[number];

export const WORKFLOW_STATE_VALUES = [
  'CREATED',
  'IN_PROGRESS',
  'QA_RUNNING',
  'EVIDENCE_READY',
  'REPAIR',
  'PACKAGING',
  'STALLED',
  'APPROVED',
  'READY_FOR_DELIVERY',
  'JOB_COMPLETED',
  'REJECTED',
  'JOB_CANCELLED',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATE_VALUES)[number];

export const AUTHORITATIVE_STATUS_VALUES = [
  'APPROVED',
  'READY_FOR_DELIVERY',
  'JOB_COMPLETED',
  'REJECTED',
  'JOB_CANCELLED',
] as const;

export type AuthoritativeStatus = (typeof AUTHORITATIVE_STATUS_VALUES)[number];

const NON_TERMINAL_STATES: readonly WorkflowState[] = [
  'CREATED',
  'IN_PROGRESS',
  'QA_RUNNING',
  'EVIDENCE_READY',
  'REPAIR',
  'PACKAGING',
  'STALLED',
  'APPROVED',
  'READY_FOR_DELIVERY',
];

const CAPABILITY: Capability = 'job:decide';
const MAX_RATIONALE_LENGTH = 8_192;
const MAX_EVIDENCE_REFS = 64;
const MAX_IDENTIFIER_LENGTH = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DecisionInput {
  readonly jobId: string;
  readonly cycle: number;
  readonly decision: DecisionKind;
  readonly rationale: string;
  readonly evidenceRefs?: readonly string[];
  readonly expectedVersion: number;
  readonly idempotencyKey?: string;
  readonly sessionHint?: string;
  readonly requestId?: string;
}

export interface DecisionData {
  readonly decisionId: string;
  readonly jobId: string;
  readonly state: WorkflowState;
  readonly authoritativeStatus: AuthoritativeStatus | null;
  readonly cycle: number;
  readonly version: number;
}

export type DecisionErrorCode =
  | 'AUTHORIZATION_DENIED'
  | 'INVALID_INPUT'
  | 'JOB_NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL_ERROR';

export const DECISION_ERROR_CODES = [
  'AUTHORIZATION_DENIED',
  'INVALID_INPUT',
  'JOB_NOT_FOUND',
  'STATE_CONFLICT',
  'INVALID_TRANSITION',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
] as const satisfies readonly DecisionErrorCode[];

export class DecisionError extends Error {
  public override readonly name = 'DecisionError';

  public constructor(
    public readonly code: DecisionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface JobRow {
  readonly job_id: string;
  readonly cycle: number;
  readonly state: WorkflowState;
  readonly authoritative_status: AuthoritativeStatus | null;
  readonly deciding_decision_id: string | null;
  readonly max_cycles: number;
  readonly version: number;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly response_json: string;
}

function isDecisionData(value: unknown): value is DecisionData {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['decisionId'] === 'string'
    && typeof candidate['jobId'] === 'string'
    && typeof candidate['state'] === 'string'
    && (WORKFLOW_STATE_VALUES as readonly string[]).includes(candidate['state'])
    && (candidate['authoritativeStatus'] === null
      || (typeof candidate['authoritativeStatus'] === 'string'
        && (AUTHORITATIVE_STATUS_VALUES as readonly string[]).includes(candidate['authoritativeStatus'])))
    && Number.isSafeInteger(candidate['cycle'])
    && (candidate['cycle'] as number) >= 0
    && typeof candidate['version'] === 'number'
    && Number.isSafeInteger(candidate['version'])
    && candidate['version'] >= 1;
}

interface TransitionSpec {
  readonly from: readonly WorkflowState[];
  readonly to: WorkflowState;
  readonly grantsStatus: AuthoritativeStatus | null;
  readonly incrementsCycle: boolean;
  readonly cycleLimitOutcome?: {
    readonly to: WorkflowState;
    readonly grantsStatus: AuthoritativeStatus | null;
    readonly incrementsCycle: boolean;
  };
}

const TRANSITIONS: Readonly<Record<DecisionKind, TransitionSpec>> = {
  APPROVE: {
    from: ['EVIDENCE_READY', 'IN_PROGRESS', 'STALLED'],
    to: 'APPROVED',
    grantsStatus: 'APPROVED',
    incrementsCycle: false,
  },
  REJECT: {
    from: ['EVIDENCE_READY', 'IN_PROGRESS', 'STALLED'],
    to: 'REJECTED',
    grantsStatus: 'REJECTED',
    incrementsCycle: false,
  },
  FIX: {
    from: ['EVIDENCE_READY'],
    to: 'REPAIR',
    grantsStatus: null,
    incrementsCycle: true,
    cycleLimitOutcome: {
      to: 'STALLED',
      grantsStatus: null,
      incrementsCycle: false,
    },
  },
  RETEST: {
    from: ['EVIDENCE_READY'],
    to: 'IN_PROGRESS',
    grantsStatus: null,
    incrementsCycle: true,
    cycleLimitOutcome: {
      to: 'STALLED',
      grantsStatus: null,
      incrementsCycle: false,
    },
  },
  VERIFY_SELF: {
    from: ['EVIDENCE_READY'],
    to: 'IN_PROGRESS',
    grantsStatus: null,
    incrementsCycle: false,
  },
  IGNORE_FALSE_POSITIVE: {
    from: ['EVIDENCE_READY'],
    to: 'EVIDENCE_READY',
    grantsStatus: null,
    incrementsCycle: false,
  },
  STOP: {
    from: NON_TERMINAL_STATES,
    to: 'STALLED',
    grantsStatus: null,
    incrementsCycle: false,
  },
  PACKAGE: {
    from: ['APPROVED'],
    to: 'PACKAGING',
    grantsStatus: null,
    incrementsCycle: false,
  },
  DELIVER: {
    from: ['PACKAGING'],
    to: 'READY_FOR_DELIVERY',
    grantsStatus: 'READY_FOR_DELIVERY',
    incrementsCycle: false,
  },
  COMPLETE: {
    from: ['READY_FOR_DELIVERY'],
    to: 'JOB_COMPLETED',
    grantsStatus: 'JOB_COMPLETED',
    incrementsCycle: false,
  },
  CANCEL: {
    from: NON_TERMINAL_STATES,
    to: 'JOB_CANCELLED',
    grantsStatus: 'JOB_CANCELLED',
    incrementsCycle: false,
  },
};

function boundedIdentifier(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new DecisionError('INVALID_INPUT', field + ' is invalid.');
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_IDENTIFIER_LENGTH || /[\r\n]/.test(trimmed)) {
    throw new DecisionError('INVALID_INPUT', field + ' is invalid.');
  }
  return trimmed;
}

function validateInput(input: DecisionInput): DecisionInput {
  const jobId = boundedIdentifier(input.jobId, 'jobId');
  if (!Number.isSafeInteger(input.cycle) || input.cycle < 0) {
    throw new DecisionError('INVALID_INPUT', 'cycle is invalid.');
  }
  if (!DECISION_VALUES.includes(input.decision)) {
    throw new DecisionError('INVALID_INPUT', 'decision is invalid.');
  }
  if (typeof input.rationale !== 'string') {
    throw new DecisionError('INVALID_INPUT', 'rationale is required and bounded.');
  }
  const rationale = input.rationale.trim();
  if (rationale === '' || rationale.length > MAX_RATIONALE_LENGTH) {
    throw new DecisionError('INVALID_INPUT', 'rationale is required and bounded.');
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new DecisionError('INVALID_INPUT', 'expectedVersion is invalid.');
  }
  if (input.evidenceRefs !== undefined && !Array.isArray(input.evidenceRefs)) {
    throw new DecisionError('INVALID_INPUT', 'evidenceRefs are invalid or exceed the bound.');
  }
  const evidenceRefs = input.evidenceRefs === undefined
    ? []
    : input.evidenceRefs.map((value) => {
      if (typeof value !== 'string') {
        throw new DecisionError('INVALID_INPUT', 'evidenceRefs are invalid or exceed the bound.');
      }
      return boundedIdentifier(value, 'evidenceRef');
    });
  if (
    evidenceRefs.length > MAX_EVIDENCE_REFS
  ) {
    throw new DecisionError('INVALID_INPUT', 'evidenceRefs are invalid or exceed the bound.');
  }
  if (new Set(evidenceRefs).size !== evidenceRefs.length) {
    throw new DecisionError('INVALID_INPUT', 'evidenceRefs must not contain duplicates.');
  }
  if (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== 'string') {
    throw new DecisionError('INVALID_INPUT', 'idempotencyKey is invalid.');
  }
  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey !== undefined && !UUID_PATTERN.test(idempotencyKey)) {
    throw new DecisionError('INVALID_INPUT', 'idempotencyKey is invalid.');
  }
  if (input.sessionHint !== undefined && typeof input.sessionHint !== 'string') {
    throw new DecisionError('INVALID_INPUT', 'sessionHint is invalid.');
  }
  const sessionHint = input.sessionHint?.trim();
  if (sessionHint !== undefined && (sessionHint === '' || sessionHint.length > MAX_IDENTIFIER_LENGTH)) {
    throw new DecisionError('INVALID_INPUT', 'sessionHint is invalid.');
  }
  return {
    jobId,
    cycle: input.cycle,
    decision: input.decision,
    rationale,
    evidenceRefs,
    expectedVersion: input.expectedVersion,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(sessionHint === undefined ? {} : { sessionHint }),
    ...(input.requestId === undefined
      ? {}
      : { requestId: boundedIdentifier(input.requestId, 'requestId') }),
  };
}

function requestHash(input: DecisionInput): string {
  return createHash('sha256').update(JSON.stringify({
    jobId: input.jobId,
    cycle: input.cycle,
    decision: input.decision,
    rationale: input.rationale,
    evidenceRefs: input.evidenceRefs ?? [],
    expectedVersion: input.expectedVersion,
    sessionHint: input.sessionHint ?? null,
  }), 'utf8').digest('hex');
}

function requireAuthority(actor: VerifiedActorAuthInfo): void {
  const validCapabilities = (() => {
    try {
      assertRoleCapabilities(actor.role, actor.capabilities);
      return canonicalCapabilitiesJson(actor.capabilities) === JSON.stringify(actor.capabilities);
    } catch {
      return false;
    }
  })();
  if (
    actor.clientId !== actor.actorId
    || actor.role !== 'principal'
    || actor.actorId !== 'codex'
    || !validCapabilities
    || !hasCapability(actor.capabilities, CAPABILITY)
  ) {
    throw new DecisionError('AUTHORIZATION_DENIED', 'The verified actor cannot make authoritative decisions.');
  }
}

function loadJob(db: SqliteDatabase, jobId: string): JobRow {
  const row = db.prepare(
    'SELECT job_id, cycle, state, authoritative_status, deciding_decision_id, max_cycles, version FROM jobs WHERE job_id = ?',
  ).get(jobId) as JobRow | undefined;
  if (row === undefined) throw new DecisionError('JOB_NOT_FOUND', 'The requested job was not found.');
  return row;
}

export interface Phase7AuthorityOptions {
  readonly artifactsRoot: string;
  readonly platform?: NodeJS.Platform;
}

const MAX_MANIFEST_BYTES = 65_536;

function createPackageManifestInTransaction(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  jobId: string,
  cycle: number,
  decisionId: string,
  requestId: string,
  createdAt: string,
  options: Phase7AuthorityOptions,
): { readonly absolute: string } {
  const evidence = db.prepare(
    `SELECT evidence_id, run_id, source_actor, trust, kind, severity, summary, artifact_id, created_at
       FROM evidence WHERE job_id = ? AND cycle = ? ORDER BY created_at, evidence_id`,
  ).all(jobId, cycle);
  const artifacts = db.prepare(
    `SELECT artifact_id, run_id, kind, mime, label, rel_path, bytes, sha256, created_by, created_at
       FROM artifacts WHERE job_id = ? AND cycle = ? ORDER BY created_at, artifact_id`,
  ).all(jobId, cycle);
  const decisions = db.prepare(
    `SELECT decision_id, cycle, decision, from_state, to_state, created_at
       FROM decisions WHERE job_id = ? ORDER BY cycle, created_at, decision_id`,
  ).all(jobId);
  const content = JSON.stringify({
    version: 1,
    job_id: jobId,
    cycle,
    package_decision_id: decisionId,
    generated_at: createdAt,
    evidence,
    artifacts,
    decisions: [...decisions, {
      decision_id: decisionId,
      cycle,
      decision: 'PACKAGE',
      from_state: 'APPROVED',
      to_state: 'PACKAGING',
      created_at: createdAt,
    }],
  }) + '\n';
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > MAX_MANIFEST_BYTES || contentBytes > MAX_ARTIFACT_BYTES) {
    throw new DecisionError('INVALID_TRANSITION', 'The package manifest exceeds its bound.');
  }
  const totals = db.prepare(
    'SELECT count(*) AS count, COALESCE(sum(bytes), 0) AS bytes FROM artifacts WHERE job_id = ?',
  ).get(jobId) as { readonly count?: unknown; readonly bytes?: unknown };
  if (Number(totals.count) >= MAX_JOB_ARTIFACT_ROWS
    || Number(totals.bytes) + contentBytes > MAX_JOB_ARTIFACT_BYTES) {
    throw new DecisionError('INVALID_TRANSITION', 'The package manifest exceeds the artifact quota.');
  }

  const artifactId = randomUUID();
  let absolute: string | undefined;
  try {
    const file = createManifestFile(options.artifactsRoot, jobId, cycle, artifactId, content, options.platform);
    absolute = file.absolute;
    db.prepare(
      `INSERT INTO artifacts(artifact_id, job_id, cycle, run_id, kind, mime, label, rel_path, bytes, sha256, created_by, created_at)
       VALUES (?, ?, ?, NULL, 'manifest', 'application/json', 'manifest', ?, ?, ?, ?, ?)`,
    ).run(artifactId, jobId, cycle, file.rel_path, file.bytes, file.sha256, actor.actorId, createdAt);
    audit.appendInTransaction({
      actorId: actor.actorId,
      actorRole: actor.role,
      sessionTokenId: actor.tokenId,
      requestId,
      sessionHint: actor.sessionLabel,
      action: 'artifact.register',
      jobId,
      cycle,
      capability: 'artifact:register',
      subjectType: 'artifact',
      subjectId: artifactId,
      result: 'ok',
      detail: { kind: 'manifest', bytes: file.bytes },
      timestamp: createdAt,
    });
    return { absolute };
  } catch (cause) {
    if (absolute !== undefined) {
      try { unlinkSync(absolute); } catch { /* best effort rollback of the filesystem side */ }
    }
    throw cause;
  }
}

function assertEvidenceReferences(
  db: SqliteDatabase,
  jobId: string,
  cycle: number,
  evidenceRefs: readonly string[],
): void {
  if (evidenceRefs.length === 0) return;
  const placeholders = evidenceRefs.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT evidence_id FROM evidence
       WHERE job_id = ? AND cycle = ? AND evidence_id IN (${placeholders})`,
  ).all(jobId, cycle, ...evidenceRefs) as Array<{ readonly evidence_id?: unknown }>;
  if (rows.length !== evidenceRefs.length) {
    throw new DecisionError(
      'INVALID_INPUT',
      'Every evidence reference must belong to the same job and cycle as the decision.',
    );
  }
}

function replayIfPresent(
  db: SqliteDatabase,
  actorId: string,
  key: string | undefined,
  hash: string,
): DecisionData | undefined {
  if (key === undefined) return undefined;
  const row = db.prepare(
    'SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND key = ?',
  ).get(actorId, key) as IdempotencyRow | undefined;
  if (row === undefined) return undefined;
  if (row.request_hash !== hash) {
    throw new DecisionError('IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different request.');
  }
  try {
    const parsed: unknown = JSON.parse(row.response_json);
    if (!isDecisionData(parsed)) {
      throw new Error('invalid decision response');
    }
    return parsed;
  } catch {
    throw new DecisionError('INTERNAL_ERROR', 'The stored idempotency response is invalid.');
  }
}

export function applyTransition(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  rawInput: DecisionInput,
  clock = () => Date.now(),
  phase7?: Phase7AuthorityOptions,
): DecisionData {
  requireAuthority(actor);
  const input = validateInput(rawInput);
  const hash = requestHash(input);
  let createdManifestPath: string | undefined;
  try {
    return withImmediateTransaction(db, () => {
    const replay = replayIfPresent(db, actor.actorId, input.idempotencyKey, hash);
    if (replay !== undefined) return replay;

    const job = loadJob(db, input.jobId);
    if (job.cycle !== input.cycle) {
      throw new DecisionError('STATE_CONFLICT', 'The job cycle does not match the requested cycle.');
    }
    if (job.version !== input.expectedVersion) {
      throw new DecisionError('STATE_CONFLICT', 'The job version changed before the decision was applied.');
    }
    assertEvidenceReferences(db, job.job_id, job.cycle, input.evidenceRefs ?? []);
    const transition = TRANSITIONS[input.decision];
    if (!transition.from.includes(job.state)) {
      throw new DecisionError('INVALID_TRANSITION', 'The requested decision is not valid for the current job state.');
    }
    const normalNextCycle = transition.incrementsCycle ? job.cycle + 1 : job.cycle;
    const cycleLimitGuard =
      normalNextCycle > job.max_cycles
      && transition.cycleLimitOutcome !== undefined;
    if (normalNextCycle > job.max_cycles && !cycleLimitGuard) {
      throw new DecisionError('INVALID_TRANSITION', 'The job has reached its cycle limit.');
    }
    const selectedTransition: TransitionSpec = cycleLimitGuard && transition.cycleLimitOutcome !== undefined
      ? { ...transition, ...transition.cycleLimitOutcome }
      : transition;
    const nextCycle = selectedTransition.incrementsCycle ? job.cycle + 1 : job.cycle;
    if (input.decision === 'DELIVER') {
      const manifests = db.prepare(
        `SELECT artifact_id, job_id, cycle, run_id, kind, mime, label, rel_path, bytes, sha256, created_by, created_at
           FROM artifacts WHERE job_id = ? AND cycle = ? AND kind = 'manifest'
          ORDER BY created_at, artifact_id`,
      ).all(job.job_id, job.cycle) as Array<Record<string, unknown>>;
      if (manifests.length !== 1) {
        throw new DecisionError('INVALID_TRANSITION', 'A manifest artifact is required before delivery.');
      }
      if (phase7 !== undefined) {
        const manifest = manifests[0];
        if (manifest === undefined || manifest['run_id'] !== null
          || manifest['created_by'] !== actor.actorId
          || !verifyArtifactFile(phase7.artifactsRoot, {
            rel_path: String(manifest['rel_path']),
            bytes: Number(manifest['bytes']),
            sha256: String(manifest['sha256']),
          }, phase7.platform)) {
          throw new DecisionError('INVALID_TRANSITION', 'The package manifest could not be verified.');
        }
      }
    }

    const decisionId = randomUUID();
    const requestId = boundedIdentifier(input.requestId ?? randomUUID(), 'requestId');
    const createdAt = new Date(clock()).toISOString();
    const evidenceJson = input.evidenceRefs === undefined || input.evidenceRefs.length === 0
      ? null
      : JSON.stringify(input.evidenceRefs);

    if (input.decision === 'PACKAGE' && phase7 !== undefined) {
      const manifest = createPackageManifestInTransaction(
        db,
        audit,
        actor,
        job.job_id,
        job.cycle,
        decisionId,
        requestId,
        createdAt,
        phase7,
      );
      createdManifestPath = manifest.absolute;
    }
    db.prepare(
      'INSERT INTO decisions(decision_id, job_id, cycle, actor_id, session_token_id, request_id, session_hint, decision, rationale, evidence_refs, from_state, to_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      decisionId,
      job.job_id,
      job.cycle,
      actor.actorId,
      actor.tokenId,
      requestId,
      input.sessionHint ?? null,
      input.decision,
      input.rationale,
      evidenceJson,
      job.state,
      selectedTransition.to,
      createdAt,
    );

    const nextStatus = selectedTransition.grantsStatus ?? job.authoritative_status;
    const nextDecidingDecisionId = selectedTransition.grantsStatus === null
      ? job.deciding_decision_id
      : decisionId;
    const update = db.prepare(
      'UPDATE jobs SET state = ?, authoritative_status = ?, deciding_decision_id = ?, cycle = ?, version = version + 1, state_reason = ?, updated_at = ? WHERE job_id = ? AND version = ?',
    ).run(
      selectedTransition.to,
      nextStatus,
      nextDecidingDecisionId,
      nextCycle,
      cycleLimitGuard ? 'max_cycles' : input.decision.toLowerCase(),
      createdAt,
      job.job_id,
      input.expectedVersion,
    );
    if (update.changes !== 1) throw new DecisionError('STATE_CONFLICT', 'The job changed before the decision completed.');

    const result: DecisionData = {
      decisionId,
      jobId: job.job_id,
      state: selectedTransition.to,
      authoritativeStatus: nextStatus,
      cycle: nextCycle,
      version: input.expectedVersion + 1,
    };
    audit.appendInTransaction({
      actorId: actor.actorId,
      actorRole: actor.role,
      sessionTokenId: actor.tokenId,
      requestId,
      sessionHint: input.sessionHint ?? null,
      action: 'codex.decide',
      jobId: job.job_id,
      cycle: nextCycle,
      capability: CAPABILITY,
      fromState: job.state,
      toState: selectedTransition.to,
      fromAuthStatus: job.authoritative_status,
      toAuthStatus: nextStatus,
      result: 'ok',
      detail: {
        decision: input.decision,
        rationale: input.rationale,
        ...(cycleLimitGuard ? { reason: 'max_cycles' } : {}),
      },
      timestamp: createdAt,
    });

    if (input.idempotencyKey !== undefined) {
      db.prepare(
        'INSERT INTO idempotency(actor_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(actor.actorId, input.idempotencyKey, hash, JSON.stringify(result), createdAt);
    }
    return result;
    });
  } catch (cause) {
    if (createdManifestPath !== undefined) {
      try { unlinkSync(createdManifestPath); } catch { /* best effort rollback of the filesystem side */ }
    }
    throw cause;
  }
}

export function transitionTable(): Readonly<Record<DecisionKind, TransitionSpec>> {
  return TRANSITIONS;
}
