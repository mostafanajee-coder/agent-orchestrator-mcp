import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { posix as posixPath, win32 as winPath } from 'node:path';

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
import {
  AUTHORITATIVE_STATUS_VALUES,
  WORKFLOW_STATE_VALUES,
  type AuthoritativeStatus,
  type WorkflowState,
} from './decide.js';

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;
const WINDOWS_DEVICE = /^\\\\[?.]\\/;
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]?$/;
const MAX_WORKSPACE_LENGTH = 4_096;
const MAX_CURSOR_LENGTH = 2_048;

const JOB_INCLUDE_VALUES = ['decisions', 'runs', 'evidence', 'artifacts'] as const;

export const JobSpecSchema = z.object({
  objective: z.string().trim().min(1).max(8_192),
  acceptance_criteria: z.array(z.string().trim().min(1).max(2_048)).min(1).max(64),
  context: z.string().trim().max(65_536).optional(),
}).strict();

export const JobCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(256),
  spec: JobSpecSchema,
  workspace: z.string().trim().min(1).max(MAX_WORKSPACE_LENGTH),
  max_cycles: z.number().int().nonnegative().optional(),
  deadline_at: z.string().trim().min(1).optional(),
  idempotency_key: z.string().regex(UUID_PATTERN).optional(),
  session_hint: z.string().trim().min(1).max(256).optional(),
}).strict();

export const JobMutationInputSchema = z.object({
  job_id: z.string().trim().min(1).max(256),
  expected_version: z.number().int().positive(),
  idempotency_key: z.string().regex(UUID_PATTERN).optional(),
  session_hint: z.string().trim().min(1).max(256).optional(),
}).strict();

export const JobGetInputSchema = z.object({
  job_id: z.string().trim().min(1).max(256),
  include: z.array(z.enum(JOB_INCLUDE_VALUES)).max(JOB_INCLUDE_VALUES.length).optional(),
  cycle: z.number().int().nonnegative().optional(),
}).strict().superRefine((input, context) => {
  if (input.include === undefined) return;
  if (new Set(input.include).size !== input.include.length) {
    context.addIssue({ code: 'custom', message: 'include must not contain duplicates.' });
  }
});

export const JobListInputSchema = z.object({
  state: z.enum(WORKFLOW_STATE_VALUES).optional(),
  authoritative_status: z.enum(AUTHORITATIVE_STATUS_VALUES).nullable().optional(),
  workspace: z.string().trim().min(1).max(MAX_WORKSPACE_LENGTH).optional(),
  updated_since: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(MAX_CURSOR_LENGTH).optional(),
}).strict();

export type JobSpec = z.infer<typeof JobSpecSchema>;
export type JobCreateInput = z.infer<typeof JobCreateInputSchema>;
export type JobMutationInput = z.infer<typeof JobMutationInputSchema>;
export type JobGetInput = z.infer<typeof JobGetInputSchema>;
export type JobListInput = z.infer<typeof JobListInputSchema>;

export interface JobRecord {
  readonly job_id: string;
  readonly workspace: string;
  readonly title: string;
  readonly spec: JobSpec;
  readonly state: WorkflowState;
  readonly state_reason: string | null;
  readonly authoritative_status: AuthoritativeStatus | null;
  readonly deciding_decision_id: string | null;
  readonly owner_actor_id: string;
  readonly cycle: number;
  readonly max_cycles: number;
  readonly version: number;
  readonly deadline_at: string | null;
  readonly stale_after_s: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export const JobRecordSchema = z.object({
  job_id: z.string(),
  workspace: z.string(),
  title: z.string(),
  spec: JobSpecSchema,
  state: z.enum(WORKFLOW_STATE_VALUES),
  state_reason: z.string().nullable(),
  authoritative_status: z.enum(AUTHORITATIVE_STATUS_VALUES).nullable(),
  deciding_decision_id: z.string().nullable(),
  owner_actor_id: z.string(),
  cycle: z.number().int().nonnegative(),
  max_cycles: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  deadline_at: z.string().nullable(),
  stale_after_s: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface JobSummary {
  readonly job_id: string;
  readonly workspace: string;
  readonly title: string;
  readonly state: WorkflowState;
  readonly state_reason: string | null;
  readonly authoritative_status: AuthoritativeStatus | null;
  readonly cycle: number;
  readonly max_cycles: number;
  readonly version: number;
  readonly owner_actor_id: string;
  readonly deadline_at: string | null;
  readonly stale_after_s: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DecisionRecord {
  readonly decision_id: string;
  readonly job_id: string;
  readonly cycle: number;
  readonly actor_id: string;
  readonly session_token_id: string | null;
  readonly request_id: string;
  readonly session_hint: string | null;
  readonly decision: string;
  readonly rationale: string;
  readonly evidence_refs: readonly string[] | null;
  readonly from_state: string;
  readonly to_state: string;
  readonly created_at: string;
}

export interface JobGetResult {
  readonly job: JobRecord;
  readonly decisions?: readonly DecisionRecord[];
}

export interface JobListResult {
  readonly jobs: readonly JobSummary[];
  readonly next_cursor?: string;
}

export type JobLifecycleErrorCode =
  | 'INVALID_INPUT'
  | 'WORKSPACE_NOT_ALLOWED'
  | 'JOB_NOT_FOUND'
  | 'AUTHORIZATION_DENIED'
  | 'STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNSUPPORTED_COLLECTION'
  | 'INTERNAL_ERROR';

export const JOB_LIFECYCLE_ERROR_CODES = [
  'INVALID_INPUT',
  'WORKSPACE_NOT_ALLOWED',
  'JOB_NOT_FOUND',
  'AUTHORIZATION_DENIED',
  'STATE_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'UNSUPPORTED_COLLECTION',
  'INTERNAL_ERROR',
] as const satisfies readonly JobLifecycleErrorCode[];

export class JobLifecycleError extends Error {
  public override readonly name = 'JobLifecycleError';

  public constructor(
    public readonly code: JobLifecycleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface JobLifecycleOptions {
  readonly workspaceRoots: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly hardMaxCycles: number;
  readonly defaultMaxCycles: number;
  readonly defaultStaleAfterS: number;
  readonly clock?: () => number;
}

interface ResolvedOptions {
  readonly workspaceRoots: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly hardMaxCycles: number;
  readonly defaultMaxCycles: number;
  readonly defaultStaleAfterS: number;
  readonly clock: () => number;
}

interface JobSqlRow {
  readonly job_id: unknown;
  readonly workspace: unknown;
  readonly title: unknown;
  readonly spec_json: unknown;
  readonly state: unknown;
  readonly state_reason: unknown;
  readonly authoritative_status: unknown;
  readonly deciding_decision_id: unknown;
  readonly owner_actor_id: unknown;
  readonly cycle: unknown;
  readonly max_cycles: unknown;
  readonly version: unknown;
  readonly deadline_at: unknown;
  readonly stale_after_s: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface DecisionSqlRow {
  readonly decision_id: unknown;
  readonly job_id: unknown;
  readonly cycle: unknown;
  readonly actor_id: unknown;
  readonly session_token_id: unknown;
  readonly request_id: unknown;
  readonly session_hint: unknown;
  readonly decision: unknown;
  readonly rationale: unknown;
  readonly evidence_refs: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly created_at: unknown;
}

interface IdempotencySqlRow {
  readonly request_hash: unknown;
  readonly response_json: unknown;
}

interface Cursor {
  readonly version: 1;
  readonly filter: string;
  readonly updated_at: string;
  readonly job_id: string;
}

const JOB_COLUMNS = [
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
] as const;

const JOB_SELECT = JOB_COLUMNS.join(', ');

function fail(code: JobLifecycleErrorCode, message: string): never {
  throw new JobLifecycleError(code, message);
}

function resolveOptions(options: JobLifecycleOptions): ResolvedOptions {
  const platform = options.platform;
  const hardMaxCycles = options.hardMaxCycles;
  const defaultMaxCycles = options.defaultMaxCycles;
  const defaultStaleAfterS = options.defaultStaleAfterS;
  if (!Number.isSafeInteger(hardMaxCycles) || hardMaxCycles < 0) {
    fail('INTERNAL_ERROR', 'The configured hard cycle limit is invalid.');
  }
  if (!Number.isSafeInteger(defaultMaxCycles) || defaultMaxCycles < 0 || defaultMaxCycles > hardMaxCycles) {
    fail('INTERNAL_ERROR', 'The configured default cycle limit is invalid.');
  }
  if (!Number.isSafeInteger(defaultStaleAfterS) || defaultStaleAfterS <= 0) {
    fail('INTERNAL_ERROR', 'The configured stale threshold is invalid.');
  }
  const workspaceRoots = options.workspaceRoots;
  if (!Array.isArray(workspaceRoots)) fail('INTERNAL_ERROR', 'The workspace-root configuration is invalid.');
  return {
    workspaceRoots,
    platform,
    hardMaxCycles,
    defaultMaxCycles,
    defaultStaleAfterS,
    clock: options.clock ?? (() => Date.now()),
  };
}

function pathApi(platform: NodeJS.Platform): typeof winPath | typeof posixPath {
  return platform === 'win32' ? winPath : posixPath;
}

function canonicalPath(value: string, platform: NodeJS.Platform): string {
  const path = pathApi(platform);
  const resolved = path.resolve(value).replace(/[\\/]$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function strictDescendant(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const path = pathApi(platform);
  const relative = path.relative(canonicalPath(parent, platform), canonicalPath(child, platform));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function rejectPathSyntax(value: string, platform: NodeJS.Platform): void {
  if (value === '' || value.length > MAX_WORKSPACE_LENGTH || /[\r\n\0]/.test(value)) {
    fail('WORKSPACE_NOT_ALLOWED', 'The workspace path is invalid.');
  }
  const path = pathApi(platform);
  if (platform === 'win32') {
    if (
      WINDOWS_DEVICE.test(value)
      || WINDOWS_UNC.test(value)
      || !WINDOWS_ABSOLUTE.test(value)
      || WINDOWS_ROOT.test(value)
    ) {
      fail('WORKSPACE_NOT_ALLOWED', 'The workspace must be a non-root local Windows path.');
    }
  } else if (!path.isAbsolute(value)) {
    fail('WORKSPACE_NOT_ALLOWED', 'The workspace must be an absolute path.');
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === '..')) {
    fail('WORKSPACE_NOT_ALLOWED', 'Workspace traversal is not allowed.');
  }
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  }
}

function assertRealDirectory(path: string, description: string): string | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail('WORKSPACE_NOT_ALLOWED', `The configured ${description} could not be inspected.`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail('WORKSPACE_NOT_ALLOWED', `The configured ${description} is not a real directory.`);
  }
  return realPath(path);
}

function assertNoRedirectedComponents(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): void {
  const path = pathApi(platform);
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const relative = path.relative(rootResolved, candidateResolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return;

  let current = rootResolved;
  for (const segment of relative.split(path.sep)) {
    if (segment === '') continue;
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        fail('WORKSPACE_NOT_ALLOWED', 'The workspace contains a link or reparse-point redirection.');
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail('WORKSPACE_NOT_ALLOWED', 'The workspace path could not be inspected.');
      }
    }
  }
}

/** Resolves and admits an existing child directory under a configured root. */
export function admitWorkspace(
  value: string,
  options: Pick<JobLifecycleOptions, 'workspaceRoots' | 'platform'>,
): string {
  const resolved = {
    platform: options.platform,
    workspaceRoots: options.workspaceRoots,
  };
  if (!Array.isArray(resolved.workspaceRoots)) {
    fail('INTERNAL_ERROR', 'The workspace-root configuration is invalid.');
  }
  const raw = typeof value === 'string' ? value.trim() : '';
  rejectPathSyntax(raw, resolved.platform);

  try {
    const stats = lstatSync(raw);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      fail('WORKSPACE_NOT_ALLOWED', 'The workspace must be a real directory.');
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('WORKSPACE_NOT_ALLOWED', 'The workspace directory does not exist.');
    }
    fail('WORKSPACE_NOT_ALLOWED', 'The workspace could not be inspected.');
  }

  const candidateReal = realPath(raw);
  if (candidateReal === undefined) fail('WORKSPACE_NOT_ALLOWED', 'The workspace could not be resolved.');

  for (const configuredRoot of resolved.workspaceRoots) {
    const root = typeof configuredRoot === 'string' ? configuredRoot.trim() : '';
    if (root === '') continue;
    rejectPathSyntax(root, resolved.platform);
    const rootReal = assertRealDirectory(root, 'workspace root');
    if (rootReal === undefined) continue;
    assertNoRedirectedComponents(root, raw, resolved.platform);
    if (canonicalPath(candidateReal, resolved.platform) === canonicalPath(rootReal, resolved.platform)) {
      continue;
    }
    if (strictDescendant(candidateReal, rootReal, resolved.platform)) return candidateReal;
  }

  fail('WORKSPACE_NOT_ALLOWED', 'The workspace is outside the configured workspace roots.');
}

function text(value: unknown, field: string, max = 4_096): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error('invalid ' + field);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error('invalid ' + field);
  }
  return value;
}

function parseStoredSpec(value: unknown): JobSpec {
  const raw = text(value, 'spec_json', 70_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('invalid spec_json');
  }
  const result = JobSpecSchema.safeParse(parsed);
  if (!result.success) throw new Error('invalid spec_json');
  return result.data;
}

function storedJob(row: JobSqlRow): JobRecord {
  try {
    const state = text(row.state, 'state', 64);
    if (!(WORKFLOW_STATE_VALUES as readonly string[]).includes(state)) throw new Error('invalid state');
    const status = row.authoritative_status === null ? null : text(row.authoritative_status, 'authoritative_status', 64);
    if (status !== null && !(AUTHORITATIVE_STATUS_VALUES as readonly string[]).includes(status)) {
      throw new Error('invalid authoritative_status');
    }
    const stateReason = row.state_reason === null ? null : text(row.state_reason, 'state_reason', 256);
    const deciding = row.deciding_decision_id === null ? null : text(row.deciding_decision_id, 'deciding_decision_id');
    const deadline = row.deadline_at === null ? null : text(row.deadline_at, 'deadline_at', 64);
    const record: JobRecord = {
      job_id: text(row.job_id, 'job_id'),
      workspace: text(row.workspace, 'workspace'),
      title: text(row.title, 'title', 256),
      spec: parseStoredSpec(row.spec_json),
      state: state as WorkflowState,
      state_reason: stateReason,
      authoritative_status: status as AuthoritativeStatus | null,
      deciding_decision_id: deciding,
      owner_actor_id: text(row.owner_actor_id, 'owner_actor_id'),
      cycle: integer(row.cycle, 'cycle', 0),
      max_cycles: integer(row.max_cycles, 'max_cycles', 0),
      version: integer(row.version, 'version', 1),
      deadline_at: deadline,
      stale_after_s: integer(row.stale_after_s, 'stale_after_s', 1),
      created_at: text(row.created_at, 'created_at', 64),
      updated_at: text(row.updated_at, 'updated_at', 64),
    };
    return record;
  } catch {
    fail('INTERNAL_ERROR', 'The stored job record is invalid.');
  }
}

function summary(job: JobRecord): JobSummary {
  return {
    job_id: job.job_id,
    workspace: job.workspace,
    title: job.title,
    state: job.state,
    state_reason: job.state_reason,
    authoritative_status: job.authoritative_status,
    cycle: job.cycle,
    max_cycles: job.max_cycles,
    version: job.version,
    owner_actor_id: job.owner_actor_id,
    deadline_at: job.deadline_at,
    stale_after_s: job.stale_after_s,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function loadJob(db: SqliteDatabase, jobId: string): JobRecord {
  const row = db.prepare(`SELECT ${JOB_SELECT} FROM jobs WHERE job_id = ?`).get(jobId) as JobSqlRow | undefined;
  if (row === undefined) fail('JOB_NOT_FOUND', 'The requested job was not found.');
  return storedJob(row);
}

function parseRequestId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256 || /[\r\n\0]/.test(value)) {
    fail('INVALID_INPUT', 'The request ID is invalid.');
  }
  return value.trim();
}

function validActorCapabilities(actor: VerifiedActorAuthInfo): boolean {
  try {
    assertRoleCapabilities(actor.role, actor.capabilities);
    return canonicalCapabilitiesJson(actor.capabilities) === JSON.stringify(actor.capabilities);
  } catch {
    return false;
  }
}

function requirePrincipal(actor: VerifiedActorAuthInfo, capability: Capability): void {
  if (
    actor.clientId !== actor.actorId
    || actor.actorId !== 'codex'
    || actor.role !== 'principal'
    || !validActorCapabilities(actor)
    || !hasCapability(actor.capabilities, capability)
  ) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot perform this lifecycle operation.');
  }
}

function requireReader(actor: VerifiedActorAuthInfo): void {
  if (
    actor.clientId !== actor.actorId
    || (actor.role !== 'principal' && actor.role !== 'observer')
    || !validActorCapabilities(actor)
    || !hasCapability(actor.capabilities, 'job:read')
  ) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot read job lifecycle data.');
  }
}

function nowIso(options: ResolvedOptions): string {
  const now = options.clock();
  if (!Number.isFinite(now)) fail('INTERNAL_ERROR', 'The lifecycle clock is invalid.');
  return new Date(now).toISOString();
}

function normalizeDeadline(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!RFC3339_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('INVALID_INPUT', 'deadline_at must be a valid RFC3339 UTC timestamp.');
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeCreateInput(input: JobCreateInput): JobCreateInput {
  const parsed = JobCreateInputSchema.safeParse(input);
  if (!parsed.success) fail('INVALID_INPUT', 'The job creation input is invalid.');
  if (parsed.data.max_cycles !== undefined && !Number.isSafeInteger(parsed.data.max_cycles)) {
    fail('INVALID_INPUT', 'max_cycles is too large.');
  }
  return parsed.data;
}

function normalizedSpec(spec: JobSpec): JobSpec {
  const parsed = JobSpecSchema.safeParse(spec);
  if (!parsed.success) fail('INVALID_INPUT', 'The job specification is invalid.');
  return parsed.data;
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function createRequestHash(input: JobCreateInput, workspace: string, deadline: string | null): string {
  const spec = normalizedSpec(input.spec);
  return canonicalHash({
    operation: 'job_create',
    title: input.title,
    objective: spec.objective,
    acceptance_criteria: spec.acceptance_criteria,
    context: spec.context ?? null,
    canonical_workspace: workspace,
    max_cycles: input.max_cycles ?? null,
    deadline_at: deadline,
  });
}

function mutationRequestHash(operation: 'job_start' | 'job_resume', input: JobMutationInput): string {
  return canonicalHash({
    operation,
    job_id: input.job_id,
    expected_version: input.expected_version,
  });
}

function readIdempotency(
  db: SqliteDatabase,
  actorId: string,
  key: string | undefined,
  hash: string,
): JobRecord | undefined {
  if (key === undefined) return undefined;
  const row = db.prepare(
    'SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND key = ?',
  ).get(actorId, key) as IdempotencySqlRow | undefined;
  if (row === undefined) return undefined;
  if (row.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different request.');
  try {
    const parsed: unknown = JSON.parse(text(row.response_json, 'response_json', 70_000));
    const result = JobRecordSchema.safeParse(parsed);
    if (!result.success) throw new Error('invalid stored response');
    return result.data;
  } catch {
    fail('INTERNAL_ERROR', 'The stored idempotency response is invalid.');
  }
}

function insertIdempotency(
  db: SqliteDatabase,
  actorId: string,
  key: string | undefined,
  hash: string,
  response: JobRecord,
  createdAt: string,
): void {
  if (key === undefined) return;
  db.prepare(
    'INSERT INTO idempotency(actor_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(actorId, key, hash, JSON.stringify(response), createdAt);
}

function decisionFromSql(row: DecisionSqlRow): DecisionRecord {
  try {
    let evidenceRefs: readonly string[] | null = null;
    if (row.evidence_refs !== null) {
      const raw = JSON.parse(text(row.evidence_refs, 'evidence_refs', 65_536)) as unknown;
      if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) throw new Error('invalid evidence refs');
      evidenceRefs = [...raw] as string[];
    }
    return {
      decision_id: text(row.decision_id, 'decision_id'),
      job_id: text(row.job_id, 'job_id'),
      cycle: integer(row.cycle, 'cycle', 0),
      actor_id: text(row.actor_id, 'actor_id'),
      session_token_id: row.session_token_id === null ? null : text(row.session_token_id, 'session_token_id'),
      request_id: text(row.request_id, 'request_id'),
      session_hint: row.session_hint === null ? null : text(row.session_hint, 'session_hint'),
      decision: text(row.decision, 'decision', 64),
      rationale: text(row.rationale, 'rationale', 8_192),
      evidence_refs: evidenceRefs,
      from_state: text(row.from_state, 'from_state', 64),
      to_state: text(row.to_state, 'to_state', 64),
      created_at: text(row.created_at, 'created_at', 64),
    };
  } catch {
    fail('INTERNAL_ERROR', 'The stored decision record is invalid.');
  }
}

function normalizeWorkspaceFilter(
  value: string,
  options: Pick<JobLifecycleOptions, 'workspaceRoots' | 'platform'>,
): string {
  return admitWorkspace(value, options);
}

function normalizeUpdatedSince(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!RFC3339_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('INVALID_INPUT', 'updated_since must be a valid RFC3339 UTC timestamp.');
  }
  return new Date(Date.parse(value)).toISOString();
}

function listFilterFingerprint(input: JobListInput, workspace: string | null, updatedSince: string | null): string {
  return canonicalHash({
    version: 1,
    state: input.state ?? null,
    status_present: input.authoritative_status !== undefined,
    authoritative_status: input.authoritative_status ?? null,
    workspace,
    updated_since: updatedSince,
  });
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string, filter: string): Cursor {
  try {
    if (value.length > MAX_CURSOR_LENGTH) throw new Error('cursor too long');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      parsed.version !== 1
      || parsed.filter !== filter
      || typeof parsed.updated_at !== 'string'
      || typeof parsed.job_id !== 'string'
      || parsed.updated_at.length > 64
      || !RFC3339_UTC.test(parsed.updated_at)
      || parsed.job_id.length === 0
      || parsed.job_id.length > 256
      || /[\r\n\0]/.test(parsed.job_id)
      || !/^[0-9a-f]{64}$/i.test(parsed.filter ?? '')
    ) throw new Error('invalid cursor');
    return parsed as Cursor;
  } catch {
    fail('INVALID_INPUT', 'The cursor is invalid or belongs to different filters.');
  }
}

/** Creates a durable, initially non-authoritative job. */
export function createJob(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  rawInput: JobCreateInput,
  requestId: string,
  options: JobLifecycleOptions,
): JobRecord {
  requirePrincipal(actor, 'job:create');
  const input = normalizeCreateInput(rawInput);
  const resolved = resolveOptions(options);
  const workspace = admitWorkspace(input.workspace, resolved);
  const deadline = normalizeDeadline(input.deadline_at);
  const spec = normalizedSpec(input.spec);
  const maxCycles = input.max_cycles ?? resolved.defaultMaxCycles;
  if (maxCycles > resolved.hardMaxCycles) fail('INVALID_INPUT', 'max_cycles exceeds hard_max_cycles.');
  const hash = createRequestHash(input, workspace, deadline);
  const safeRequestId = parseRequestId(requestId);
  const createdAt = nowIso(resolved);

  return withImmediateTransaction(db, () => {
    const replay = readIdempotency(db, actor.actorId, input.idempotency_key, hash);
    if (replay !== undefined) return replay;

    const jobId = randomUUID();
    const record: JobRecord = {
      job_id: jobId,
      workspace,
      title: input.title,
      spec,
      state: 'CREATED',
      state_reason: null,
      authoritative_status: null,
      deciding_decision_id: null,
      owner_actor_id: actor.actorId,
      cycle: 0,
      max_cycles: maxCycles,
      version: 1,
      deadline_at: deadline,
      stale_after_s: resolved.defaultStaleAfterS,
      created_at: createdAt,
      updated_at: createdAt,
    };
    db.prepare(
      `INSERT INTO jobs(${JOB_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.job_id,
      record.workspace,
      record.title,
      JSON.stringify(record.spec),
      record.state,
      record.state_reason,
      record.authoritative_status,
      record.deciding_decision_id,
      record.owner_actor_id,
      record.cycle,
      record.max_cycles,
      record.version,
      record.deadline_at,
      record.stale_after_s,
      record.created_at,
      record.updated_at,
    );
    audit.appendInTransaction({
      actorId: actor.actorId,
      actorRole: actor.role,
      sessionTokenId: actor.tokenId,
      requestId: safeRequestId,
      sessionHint: input.session_hint ?? null,
      action: 'job.create',
      jobId: record.job_id,
      cycle: record.cycle,
      capability: 'job:create',
      subjectType: 'job',
      subjectId: record.job_id,
      toState: record.state,
      result: 'ok',
      detail: { max_cycles: record.max_cycles },
      timestamp: createdAt,
    });
    insertIdempotency(db, actor.actorId, input.idempotency_key, hash, record, createdAt);
    return record;
  });
}

function mutateLifecycleJob(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  rawInput: JobMutationInput,
  operation: 'job_start' | 'job_resume',
  requestId: string,
  options: JobLifecycleOptions,
): JobRecord {
  requirePrincipal(actor, 'job:create');
  const parsed = JobMutationInputSchema.safeParse(rawInput);
  if (!parsed.success) fail('INVALID_INPUT', 'The lifecycle input is invalid.');
  const input = parsed.data;
  const resolved = resolveOptions(options);
  const hash = mutationRequestHash(operation, input);
  const safeRequestId = parseRequestId(requestId);
  const createdAt = nowIso(resolved);
  const expectedState = operation === 'job_start' ? 'CREATED' : 'REPAIR';
  const nextState = 'IN_PROGRESS';
  const action = operation === 'job_start' ? 'job.start' : 'job.resume';

  return withImmediateTransaction(db, () => {
    const replay = readIdempotency(db, actor.actorId, input.idempotency_key, hash);
    if (replay !== undefined) return replay;

    const job = loadJob(db, input.job_id);
    if (job.version !== input.expected_version) {
      fail('STATE_CONFLICT', 'The job version changed before the lifecycle operation was applied.');
    }
    if (job.state !== expectedState) {
      fail('STATE_CONFLICT', 'The lifecycle operation is not valid for the current job state.');
    }
    const update = db.prepare(
      'UPDATE jobs SET state = ?, state_reason = ?, version = version + 1, updated_at = ? WHERE job_id = ? AND state = ? AND version = ?',
    ).run(nextState, operation === 'job_start' ? 'start' : 'resume', createdAt, input.job_id, expectedState, input.expected_version);
    if (update.changes !== 1) fail('STATE_CONFLICT', 'The job changed before the lifecycle operation completed.');

    const record = loadJob(db, input.job_id);
    audit.appendInTransaction({
      actorId: actor.actorId,
      actorRole: actor.role,
      sessionTokenId: actor.tokenId,
      requestId: safeRequestId,
      sessionHint: input.session_hint ?? null,
      action,
      jobId: record.job_id,
      cycle: record.cycle,
      capability: 'job:create',
      subjectType: 'job',
      subjectId: record.job_id,
      fromState: job.state,
      toState: record.state,
      fromAuthStatus: job.authoritative_status,
      toAuthStatus: record.authoritative_status,
      result: 'ok',
      detail: { operation },
      timestamp: createdAt,
    });
    insertIdempotency(db, actor.actorId, input.idempotency_key, hash, record, createdAt);
    return record;
  });
}

export function startJob(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  input: JobMutationInput,
  requestId: string,
  options: JobLifecycleOptions,
): JobRecord {
  return mutateLifecycleJob(db, audit, actor, input, 'job_start', requestId, options);
}

export function resumeJob(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  input: JobMutationInput,
  requestId: string,
  options: JobLifecycleOptions,
): JobRecord {
  return mutateLifecycleJob(db, audit, actor, input, 'job_resume', requestId, options);
}

export function getJob(
  db: SqliteDatabase,
  actor: VerifiedActorAuthInfo,
  rawInput: JobGetInput,
): JobGetResult {
  requireReader(actor);
  const parsed = JobGetInputSchema.safeParse(rawInput);
  if (!parsed.success) fail('INVALID_INPUT', 'The job read input is invalid.');
  const input = parsed.data;
  if (input.include?.some((value) => value !== 'decisions') === true) {
    fail('UNSUPPORTED_COLLECTION', 'runs, evidence, and artifacts are not available in Phase 5.');
  }
  const job = loadJob(db, input.job_id);
  if (input.include?.includes('decisions') !== true) return { job };
  const rows = input.cycle === undefined
    ? db.prepare(
      'SELECT decision_id, job_id, cycle, actor_id, session_token_id, request_id, session_hint, decision, rationale, evidence_refs, from_state, to_state, created_at FROM decisions WHERE job_id = ? ORDER BY cycle, created_at, decision_id',
    ).all(job.job_id)
    : db.prepare(
      'SELECT decision_id, job_id, cycle, actor_id, session_token_id, request_id, session_hint, decision, rationale, evidence_refs, from_state, to_state, created_at FROM decisions WHERE job_id = ? AND cycle = ? ORDER BY cycle, created_at, decision_id',
    ).all(job.job_id, input.cycle);
  return { job, decisions: (rows as DecisionSqlRow[]).map(decisionFromSql) };
}

export function listJobs(
  db: SqliteDatabase,
  actor: VerifiedActorAuthInfo,
  rawInput: JobListInput,
  options: JobLifecycleOptions,
): JobListResult {
  requireReader(actor);
  const parsed = JobListInputSchema.safeParse(rawInput);
  if (!parsed.success) fail('INVALID_INPUT', 'The job list input is invalid.');
  const input = parsed.data;
  const resolved = resolveOptions(options);
  const workspace = input.workspace === undefined
    ? null
    : normalizeWorkspaceFilter(input.workspace, resolved);
  const updatedSince = normalizeUpdatedSince(input.updated_since);
  const filter = listFilterFingerprint(input, workspace, updatedSince);
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, filter);
  const limit = input.limit ?? 50;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.state !== undefined) {
    clauses.push('state = ?');
    params.push(input.state);
  }
  if (input.authoritative_status !== undefined) {
    if (input.authoritative_status === null) clauses.push('authoritative_status IS NULL');
    else {
      clauses.push('authoritative_status IS ?');
      params.push(input.authoritative_status);
    }
  }
  if (workspace !== null) {
    clauses.push('workspace = ?');
    params.push(workspace);
  }
  if (updatedSince !== null) {
    clauses.push('updated_at >= ?');
    params.push(updatedSince);
  }
  if (cursor !== undefined) {
    clauses.push('(updated_at < ? OR (updated_at = ? AND job_id < ?))');
    params.push(cursor.updated_at, cursor.updated_at, cursor.job_id);
  }
  const where = clauses.length === 0 ? '' : ' WHERE ' + clauses.join(' AND ');
  const rows = db.prepare(
    `SELECT ${JOB_SELECT} FROM jobs${where} ORDER BY updated_at DESC, job_id DESC LIMIT ?`,
  ).all(...params, limit + 1) as JobSqlRow[];
  const hasNext = rows.length > limit;
  const selected = hasNext ? rows.slice(0, limit) : rows;
  const jobs = selected.map((row) => summary(storedJob(row)));
  if (!hasNext || jobs.length === 0) return { jobs };
  const last = jobs[jobs.length - 1];
  if (last === undefined) return { jobs };
  return {
    jobs,
    next_cursor: encodeCursor({
      version: 1,
      filter,
      updated_at: last.updated_at,
      job_id: last.job_id,
    }),
  };
}
