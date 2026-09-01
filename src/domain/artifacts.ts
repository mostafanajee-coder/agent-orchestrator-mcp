import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, posix as posixPath, win32 as winPath } from 'node:path';
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
import { redactSensitiveText } from '../security/redaction.js';
import {
  requireActiveWorkerLease,
  type ActiveWorkerLease,
  type WorkerLeaseOptions,
} from './workerLease.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_KIND_BYTES = 64;
const MAX_MIME_BYTES = 128;
const MAX_LABEL_BYTES = 256;
const MAX_SOURCE_PATH_BYTES = 512;
const MAX_STORED_PATH_BYTES = 512;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_JOB_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const MAX_JOB_ARTIFACT_ROWS = 256;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_BYTES = 2_048;
const COPY_BUFFER_BYTES = 64 * 1024;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SAFE_SEGMENT = /[^A-Za-z0-9._-]/g;

export const ArtifactRegisterInputSchema = z.object({
  job_id: z.string().trim().min(1).max(MAX_IDENTIFIER_BYTES),
  cycle: z.number().int().nonnegative(),
  run_id: z.string().trim().min(1).max(MAX_IDENTIFIER_BYTES).optional(),
  source_path: z.string().trim().min(1).max(MAX_SOURCE_PATH_BYTES),
  kind: z.string().trim().min(1).max(MAX_KIND_BYTES),
  mime: z.string().trim().min(1).max(MAX_MIME_BYTES).optional(),
  label: z.string().trim().min(1).max(MAX_LABEL_BYTES).optional(),
  lease: z.string().trim().min(1).max(16_384).optional(),
  idempotency_key: z.string().regex(UUID_PATTERN),
}).strict();

export const ArtifactListInputSchema = z.object({
  job_id: z.string().trim().min(1).max(MAX_IDENTIFIER_BYTES),
  cycle: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().trim().min(1).max(MAX_CURSOR_BYTES).optional(),
}).strict();

export interface ArtifactRecord {
  readonly artifact_id: string;
  readonly job_id: string;
  readonly cycle: number;
  readonly run_id: string | null;
  readonly kind: string;
  readonly mime: string | null;
  readonly label: string | null;
  readonly rel_path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface ArtifactListResult {
  readonly artifacts: readonly ArtifactRecord[];
  readonly next_cursor?: string;
}

export type ArtifactRegisterInput = z.infer<typeof ArtifactRegisterInputSchema>;
export type ArtifactListInput = z.infer<typeof ArtifactListInputSchema>;

export interface ArtifactOptions extends WorkerLeaseOptions {
  readonly artifactsRoot: string;
  readonly platform?: NodeJS.Platform;
}

export type ArtifactErrorCode =
  | 'INVALID_INPUT'
  | 'AUTHORIZATION_DENIED'
  | 'JOB_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'LEASE_INVALID'
  | 'STALE_CYCLE'
  | 'PATH_REJECTED'
  | 'QUOTA_EXCEEDED'
  | 'HASH_MISMATCH'
  | 'LIMIT_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL_ERROR';

export const ARTIFACT_ERROR_CODES = [
  'INVALID_INPUT',
  'AUTHORIZATION_DENIED',
  'JOB_NOT_FOUND',
  'RUN_NOT_FOUND',
  'LEASE_INVALID',
  'STALE_CYCLE',
  'PATH_REJECTED',
  'QUOTA_EXCEEDED',
  'HASH_MISMATCH',
  'LIMIT_EXCEEDED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
] as const satisfies readonly ArtifactErrorCode[];

export class ArtifactError extends Error {
  public override readonly name = 'ArtifactError';

  public constructor(
    public readonly code: ArtifactErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface ArtifactSqlRow {
  readonly artifact_id: unknown;
  readonly job_id: unknown;
  readonly cycle: unknown;
  readonly run_id: unknown;
  readonly kind: unknown;
  readonly mime: unknown;
  readonly label: unknown;
  readonly rel_path: unknown;
  readonly bytes: unknown;
  readonly sha256: unknown;
  readonly created_by: unknown;
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
  readonly artifact_id: string;
}

interface AdmissionContext {
  readonly actorId: string;
  readonly actorRole: 'principal' | 'worker';
  readonly capabilities: readonly Capability[];
  readonly sessionTokenId: string | null;
  readonly sessionHint: string | null;
  readonly lease?: ActiveWorkerLease;
}

function platformOf(options: ArtifactOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function pathApi(platform: NodeJS.Platform): typeof winPath | typeof posixPath {
  return platform === 'win32' ? winPath : posixPath;
}

function fail(code: ArtifactErrorCode, message: string): never {
  throw new ArtifactError(code, message);
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

function nowIso(options: ArtifactOptions): string {
  return new Date((options.clock ?? (() => Date.now()))()).toISOString();
}

function safePathSegment(value: string): string {
  const segment = value.replace(SAFE_SEGMENT, '_').replace(/^[. ]+|[. ]+$/g, '');
  return segment === '' || segment === '.' || segment === '..' ? '_' : segment.slice(0, 128);
}

function relativeParts(value: string, platform: NodeJS.Platform): string[] {
  if (value.includes('\0') || /[\r\n]/.test(value) || value.trim() === '') {
    fail('PATH_REJECTED', 'The artifact source path is invalid.');
  }
  const api = pathApi(platform);
  if (api.isAbsolute(value) || winPath.isAbsolute(value) || posixPath.isAbsolute(value)
    || value.startsWith('\\') || value.startsWith('/')) {
    fail('PATH_REJECTED', 'Artifact source paths must be relative.');
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes(':')
    || [...part].some((character) => character.charCodeAt(0) < 0x20)
    || /[. ]$/.test(part) || (platform === 'win32' && WINDOWS_RESERVED.test(part)))) {
    fail('PATH_REJECTED', 'The artifact source path contains a prohibited segment.');
  }
  return parts;
}

function canonicalPath(path: string, platform: NodeJS.Platform): string {
  const value = platform === 'win32' ? path.replace(/[\\/]+/g, '\\').toLowerCase() : path;
  return value.endsWith(platform === 'win32' ? '\\' : '/') ? value.slice(0, -1) : value;
}

function isContained(root: string, target: string, platform: NodeJS.Platform): boolean {
  const rootValue = canonicalPath(root, platform);
  const targetValue = canonicalPath(target, platform);
  const separator = platform === 'win32' ? '\\' : '/';
  return targetValue === rootValue || targetValue.startsWith(rootValue + separator);
}

function assertNoLinksAtOrBelow(root: string, target: string, platform: NodeJS.Platform): void {
  if (!isContained(root, target, platform)) fail('PATH_REJECTED', 'The artifact path escapes its root.');
  const api = pathApi(platform);
  let current = target;
  for (;;) {
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      fail('PATH_REJECTED', 'The artifact path could not be inspected.');
    }
    if (stats.isSymbolicLink()) fail('PATH_REJECTED', 'Symbolic links and reparse points are not accepted.');
    if (canonicalPath(current, platform) === canonicalPath(root, platform)) return;
    const parent = api.dirname(current);
    if (parent === current) fail('PATH_REJECTED', 'The artifact path root is invalid.');
    current = parent;
  }
}

function ensureDirectoryWithinRoot(root: string, target: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  let resolvedRoot: string;
  const requestedRoot = api.resolve(root);
  const requestedTarget = api.resolve(target);
  try {
    resolvedRoot = realpathSync.native(root);
  } catch {
    fail('PATH_REJECTED', 'The artifact root could not be inspected.');
  }
  const relative = api.relative(requestedRoot, requestedTarget);
  if (relative.startsWith('..') || api.isAbsolute(relative) || !isContained(
    requestedRoot,
    requestedTarget,
    platform,
  )) {
    fail('PATH_REJECTED', 'The artifact directory escapes its root.');
  }
  // Build the target from the resolved root. On Windows, the original and
  // realpath forms can differ by short-name/long-name representation even
  // when they identify the same directory.
  const resolvedTarget = api.join(resolvedRoot, relative);
  let current = resolvedRoot;
  for (const segment of relative.split(/[\\/]/).filter((value) => value !== '')) {
    current = api.join(current, segment);
    try {
      const stats = lstatSync(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        fail('PATH_REJECTED', 'Symbolic links and reparse points are not accepted.');
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (cause instanceof ArtifactError) throw cause;
        fail('PATH_REJECTED', 'The artifact directory could not be inspected.');
      }
      try {
        mkdirSync(current);
        const created = lstatSync(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          fail('PATH_REJECTED', 'The artifact directory is not a real directory.');
        }
      } catch (createCause) {
        if (createCause instanceof ArtifactError) throw createCause;
        fail('PATH_REJECTED', 'The artifact directory could not be prepared.');
      }
    }
  }
  assertNoLinksAtOrBelow(resolvedRoot, resolvedTarget, platform);
  return resolvedTarget;
}

export function artifactStagingDirectory(
  artifactsRoot: string,
  jobId: string,
  cycle: number,
  runId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = pathApi(platform);
  return api.join(
    artifactsRoot,
    '.staging',
    safePathSegment(jobId),
    String(cycle),
    safePathSegment(runId),
  );
}

export function ensureArtifactStagingDirectory(
  artifactsRoot: string,
  jobId: string,
  cycle: number,
  runId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const staging = artifactStagingDirectory(artifactsRoot, jobId, cycle, runId, platform);
  return ensureDirectoryWithinRoot(artifactsRoot, staging, platform);
}

function sourceFile(root: string, sourcePath: string, platform: NodeJS.Platform): string {
  const parts = relativeParts(sourcePath, platform);
  const api = pathApi(platform);
  const resolvedRoot = realpathSync.native(root);
  const candidate = api.join(resolvedRoot, ...parts);
  if (!isContained(resolvedRoot, candidate, platform)) fail('PATH_REJECTED', 'The artifact source path escapes its root.');
  try {
    assertNoLinksAtOrBelow(resolvedRoot, candidate, platform);
    const stats = lstatSync(candidate);
    if (!stats.isFile()) fail('PATH_REJECTED', 'The artifact source is not a regular file.');
  } catch (cause) {
    if (cause instanceof ArtifactError) throw cause;
    fail('PATH_REJECTED', 'The artifact source file is unavailable.');
  }
  return candidate;
}

function safeFileName(sourcePath: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  const raw = basename(sourcePath.replace(/[\\/]+/g, api.sep));
  let value = raw.replace(SAFE_SEGMENT, '_').replace(/^[. ]+|[. ]+$/g, '');
  if (value === '' || value === '.' || value === '..' || (platform === 'win32' && WINDOWS_RESERVED.test(value))) {
    value = 'artifact';
  }
  while (byteLength(value) > 128) value = value.slice(0, -1);
  return value || 'artifact';
}

function copyAndHash(source: string, finalPath: string): { readonly bytes: number; readonly sha256: string } {
  let sourceFd: number | undefined;
  let targetFd: number | undefined;
  const tempPath = finalPath + '.tmp-' + randomUUID();
  const digest = createHash('sha256');
  let total = 0;
  try {
    sourceFd = openSync(source, 'r');
    const sourceStats = fstatSync(sourceFd);
    if (!sourceStats.isFile()) fail('PATH_REJECTED', 'The artifact source is not a regular file.');
    targetFd = openSync(tempPath, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    for (;;) {
      const read = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_ARTIFACT_BYTES) fail('LIMIT_EXCEEDED', 'The artifact exceeds its byte limit.');
      const chunk = buffer.subarray(0, read);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = writeSync(targetFd, chunk, offset, chunk.byteLength - offset);
        if (written <= 0) fail('INTERNAL_ERROR', 'The artifact could not be copied.');
        offset += written;
      }
    }
    fsyncSync(targetFd);
    closeSync(targetFd);
    targetFd = undefined;
    closeSync(sourceFd);
    sourceFd = undefined;
    renameSync(tempPath, finalPath);
    return { bytes: total, sha256: digest.digest('hex') };
  } catch (cause) {
    if (cause instanceof ArtifactError) throw cause;
    fail('INTERNAL_ERROR', 'The artifact could not be copied.');
  } finally {
    if (targetFd !== undefined) {
      try { closeSync(targetFd); } catch { /* preserve original error */ }
    }
    if (sourceFd !== undefined) {
      try { closeSync(sourceFd); } catch { /* preserve original error */ }
    }
    try { unlinkSync(tempPath); } catch { /* absent after rename */ }
  }
  throw new ArtifactError('INTERNAL_ERROR', 'The artifact could not be copied.');
}

function writeBytesAndHash(content: Buffer, finalPath: string): { readonly bytes: number; readonly sha256: string } {
  const tempPath = finalPath + '.tmp-' + randomUUID();
  let targetFd: number | undefined;
  try {
    targetFd = openSync(tempPath, 'wx', 0o600);
    let offset = 0;
    while (offset < content.byteLength) {
      const written = writeSync(targetFd, content, offset, content.byteLength - offset);
      if (written <= 0) fail('INTERNAL_ERROR', 'The artifact content could not be stored.');
      offset += written;
    }
    fsyncSync(targetFd);
    closeSync(targetFd);
    targetFd = undefined;
    renameSync(tempPath, finalPath);
    return { bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
  } catch (cause) {
    if (cause instanceof ArtifactError) throw cause;
    fail('INTERNAL_ERROR', 'The artifact content could not be stored.');
  } finally {
    if (targetFd !== undefined) {
      try { closeSync(targetFd); } catch { /* preserve original error */ }
    }
    try { unlinkSync(tempPath); } catch { /* absent after rename */ }
  }
  throw new ArtifactError('INTERNAL_ERROR', 'The artifact content could not be stored.');
}

function parseInput(raw: unknown): ArtifactRegisterInput {
  const parsed = ArtifactRegisterInputSchema.safeParse(raw);
  if (!parsed.success) fail('INVALID_INPUT', 'The artifact input is invalid.');
  const input: ArtifactRegisterInput = {
    ...parsed.data,
    kind: safeText(parsed.data.kind, parsed.data.lease),
    ...(parsed.data.mime === undefined ? {} : { mime: safeText(parsed.data.mime, parsed.data.lease) }),
    ...(parsed.data.label === undefined ? {} : { label: safeText(parsed.data.label, parsed.data.lease) }),
  };
  if (byteLength(input.job_id) > MAX_IDENTIFIER_BYTES
    || byteLength(input.run_id ?? '') > MAX_IDENTIFIER_BYTES
    || byteLength(input.source_path) > MAX_SOURCE_PATH_BYTES
    || byteLength(input.kind) > MAX_KIND_BYTES
    || byteLength(input.mime ?? '') > MAX_MIME_BYTES
    || byteLength(input.label ?? '') > MAX_LABEL_BYTES) {
    fail('INVALID_INPUT', 'An artifact field exceeds its byte bound.');
  }
  return input;
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
  db: SqliteDatabase,
  actor: VerifiedActorAuthInfo,
  input: ArtifactRegisterInput,
  options: ArtifactOptions,
): AdmissionContext {
  if (!validActor(actor) || !hasCapability(actor.capabilities, 'artifact:register')) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot register artifacts.');
  }
  if (actor.role === 'principal') {
    if (actor.actorId !== 'codex' || input.lease !== undefined) {
      fail('AUTHORIZATION_DENIED', 'The principal artifact binding is invalid.');
    }
    return {
      actorId: actor.actorId,
      actorRole: 'principal',
      capabilities: actor.capabilities,
      sessionTokenId: actor.tokenId,
      sessionHint: actor.sessionLabel,
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
  if (!hasCapability(lease.capabilities, 'artifact:register') || input.run_id !== lease.payload.run_id) {
    fail('AUTHORIZATION_DENIED', 'The worker is not authorized for this artifact binding.');
  }
  return {
    actorId: actor.actorId,
    actorRole: 'worker',
    capabilities: lease.capabilities,
    sessionTokenId: actor.tokenId,
    sessionHint: actor.sessionLabel,
    lease,
  };
}

function runtimeActor(active: ActiveWorkerLease): VerifiedActorAuthInfo {
  return {
    clientId: active.actorId,
    scopes: ['mcp'],
    tokenId: 'runtime',
    sessionLabel: 'runtime',
    expiresAt: Number.MAX_SAFE_INTEGER,
    actorId: active.actorId,
    role: 'worker',
    capabilities: active.capabilities,
  };
}

function requestHash(input: ArtifactRegisterInput): string {
  return createHash('sha256').update(JSON.stringify({
    operation: 'artifact_register',
    job_id: input.job_id,
    cycle: input.cycle,
    run_id: input.run_id ?? null,
    source_path: input.source_path,
    kind: input.kind,
    mime: input.mime ?? null,
    label: input.label ?? null,
    lease: input.lease ?? null,
  }), 'utf8').digest('hex');
}

export const ArtifactRecordSchema = z.object({
  artifact_id: z.string(),
  job_id: z.string(),
  cycle: z.number().int().nonnegative(),
  run_id: z.string().nullable(),
  kind: z.string(),
  mime: z.string().nullable(),
  label: z.string().nullable(),
  rel_path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  created_by: z.string(),
  created_at: z.string(),
});

function parseStored(row: ArtifactSqlRow): ArtifactRecord {
  const result: ArtifactRecord = {
    artifact_id: String(row.artifact_id),
    job_id: String(row.job_id),
    cycle: Number(row.cycle),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    kind: safeText(String(row.kind), undefined),
    mime: row.mime === null || row.mime === undefined ? null : safeText(String(row.mime), undefined),
    label: row.label === null || row.label === undefined ? null : safeText(String(row.label), undefined),
    rel_path: safeText(String(row.rel_path), undefined),
    bytes: Number(row.bytes),
    sha256: String(row.sha256),
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  };
  if (!ArtifactRecordSchema.safeParse(result).success) {
    fail('INTERNAL_ERROR', 'An artifact row has an invalid stored shape.');
  }
  return result;
}

function readIdempotency(
  db: SqliteDatabase,
  actorId: string,
  key: string,
  hash: string,
  lease: string | undefined,
): ArtifactRecord | undefined {
  const row = db.prepare(
    'SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND key = ?',
  ).get(actorId, key) as IdempotencyRow | undefined;
  if (row === undefined) return undefined;
  if (row.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was used for different artifact input.');
  try {
    const parsed: unknown = JSON.parse(String(row.response_json));
    const result = ArtifactRecordSchema.safeParse(parsed);
    if (!result.success) fail('INTERNAL_ERROR', 'The stored artifact idempotency response is invalid.');
    return {
      ...result.data,
      kind: safeText(result.data.kind, lease),
      mime: result.data.mime === null ? null : safeText(result.data.mime, lease),
      label: result.data.label === null ? null : safeText(result.data.label, lease),
      rel_path: safeText(result.data.rel_path, lease),
    };
  } catch (cause) {
    if (cause instanceof ArtifactError) throw cause;
    fail('INTERNAL_ERROR', 'The stored artifact idempotency response is invalid.');
  }
}

function loadJob(
  db: SqliteDatabase,
  jobId: string,
): { readonly job_id: string; readonly cycle: number; readonly workspace: string } {
  const row = db.prepare('SELECT job_id, cycle, workspace FROM jobs WHERE job_id = ?').get(jobId) as Record<string, unknown> | undefined;
  if (row === undefined) fail('JOB_NOT_FOUND', 'The requested job was not found.');
  return { job_id: String(row['job_id']), cycle: Number(row['cycle']), workspace: String(row['workspace']) };
}

function assertLeaseInsideTransaction(
  db: SqliteDatabase,
  context: AdmissionContext,
  input: ArtifactRegisterInput,
  options: ArtifactOptions,
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

function assertBindingsAndQuota(
  db: SqliteDatabase,
  context: AdmissionContext,
  input: ArtifactRegisterInput,
  bytes: number,
  options: ArtifactOptions,
): void {
  const job = loadJob(db, input.job_id);
  if (job.cycle !== input.cycle) fail('STALE_CYCLE', 'The artifact cycle does not match the current job cycle.');
  assertLeaseInsideTransaction(db, context, input, options);
  if (context.lease !== undefined && input.run_id !== context.lease.payload.run_id) {
    fail('LEASE_INVALID', 'The worker lease does not match the artifact run.');
  }
  if (input.run_id !== undefined) {
    const run = db.prepare(
      'SELECT 1 AS present FROM worker_runs WHERE run_id = ? AND job_id = ? AND cycle = ?',
    ).get(input.run_id, input.job_id, input.cycle) as { readonly present?: number } | undefined;
    if (run?.present !== 1) fail('RUN_NOT_FOUND', 'The artifact run was not found for this job cycle.');
  }
  const totals = db.prepare(
    'SELECT count(*) AS count, COALESCE(sum(bytes), 0) AS bytes FROM artifacts WHERE job_id = ?',
  ).get(input.job_id) as { readonly count?: unknown; readonly bytes?: unknown };
  if (Number(totals.count) >= MAX_JOB_ARTIFACT_ROWS
    || Number(totals.bytes) + bytes > MAX_JOB_ARTIFACT_BYTES) {
    fail('QUOTA_EXCEEDED', 'The artifact quota for this job has been reached.');
  }
}

function insertArtifactInTransaction(
  db: SqliteDatabase,
  audit: AuditWriter,
  input: ArtifactRegisterInput,
  context: AdmissionContext,
  record: ArtifactRecord,
  requestId: string,
  options: ArtifactOptions,
): ArtifactRecord {
  assertBindingsAndQuota(db, context, input, record.bytes, options);
  if (byteLength(record.rel_path) > MAX_STORED_PATH_BYTES) fail('PATH_REJECTED', 'The stored artifact path exceeds its bound.');
  db.prepare(
    `INSERT INTO artifacts(artifact_id, job_id, cycle, run_id, kind, mime, label, rel_path, bytes, sha256, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.artifact_id,
    record.job_id,
    record.cycle,
    record.run_id,
    record.kind,
    record.mime,
    record.label,
    record.rel_path,
    record.bytes,
    record.sha256,
    record.created_by,
    record.created_at,
  );
  audit.appendInTransaction({
    actorId: context.actorId,
    actorRole: context.actorRole,
    sessionTokenId: context.sessionTokenId,
    requestId,
    sessionHint: context.sessionHint,
    action: 'artifact.register',
    jobId: record.job_id,
    cycle: record.cycle,
    capability: 'artifact:register',
    subjectType: 'artifact',
    subjectId: record.artifact_id,
    result: 'ok',
    detail: { kind: record.kind, bytes: record.bytes, run_id: record.run_id },
    secretValues: secretValues(input.lease),
    timestamp: record.created_at,
  });
  return record;
}

function recordArtifactRejection(
  audit: AuditWriter,
  context: AdmissionContext,
  input: ArtifactRegisterInput,
  requestId: string,
  error: ArtifactError,
): void {
  const action = error.code === 'QUOTA_EXCEEDED'
    ? 'artifact.quota_rejected'
    : error.code === 'HASH_MISMATCH'
      ? 'artifact.hash_mismatch'
      : 'artifact.rejected';
  try {
    audit.append({
      actorId: context.actorId,
      actorRole: context.actorRole,
      sessionTokenId: context.sessionTokenId,
      requestId,
      sessionHint: context.sessionHint,
      action,
      jobId: input.job_id,
      cycle: input.cycle,
      capability: 'artifact:register',
      subjectType: 'artifact',
      result: 'denied',
      detail: { code: error.code },
      secretValues: secretValues(input.lease),
    });
  } catch {
    // A rejected request must not hide its original typed error.
  }
}

function finalPath(
  artifactsRoot: string,
  record: Pick<ArtifactRecord, 'artifact_id' | 'job_id' | 'cycle' | 'run_id'>,
  fileName: string,
  platform: NodeJS.Platform,
  scopeOverride?: string,
): { readonly absolute: string; readonly relative: string } {
  const scope = scopeOverride ?? (record.run_id === null ? 'principal' : safePathSegment(record.run_id));
  const relative = [
    safePathSegment(record.job_id),
    String(record.cycle),
    scope,
    record.artifact_id + '-' + fileName,
  ].join('/');
  const api = pathApi(platform);
  const absolute = api.join(artifactsRoot, ...relative.split('/'));
  return { absolute, relative };
}

export function createManifestFile(
  artifactsRoot: string,
  jobId: string,
  cycle: number,
  artifactId: string,
  content: string,
  platform: NodeJS.Platform = process.platform,
): { readonly absolute: string; readonly rel_path: string; readonly bytes: number; readonly sha256: string } {
  const path = finalPath(artifactsRoot, {
    artifact_id: artifactId,
    job_id: jobId,
    cycle,
    run_id: null,
  }, 'manifest.json', platform, 'package');
  const directory = ensureDirectoryWithinRoot(artifactsRoot, dirname(path.absolute), platform);
  const absolute = pathApi(platform).join(directory, pathApi(platform).basename(path.absolute));
  const root = realpathSync.native(artifactsRoot);
  assertNoLinksAtOrBelow(root, directory, platform);
  const result = writeBytesAndHash(Buffer.from(content, 'utf8'), absolute);
  return { absolute, rel_path: path.relative, ...result };
}

export function verifyArtifactFile(
  artifactsRoot: string,
  record: Pick<ArtifactRecord, 'rel_path' | 'bytes' | 'sha256'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let parts: string[];
  try {
    parts = relativeParts(record.rel_path, platform);
    const root = realpathSync.native(artifactsRoot);
    const absolute = pathApi(platform).join(root, ...parts);
    if (!isContained(root, absolute, platform)) return false;
    assertNoLinksAtOrBelow(root, absolute, platform);
    const fd = openSync(absolute, 'r');
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) return false;
      const digest = createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let total = 0;
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.byteLength, null);
        if (read === 0) break;
        total += read;
        if (total > MAX_ARTIFACT_BYTES) return false;
        digest.update(buffer.subarray(0, read));
      }
      return total === record.bytes && digest.digest('hex') === record.sha256;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function registerArtifact(
  db: SqliteDatabase,
  audit: AuditWriter,
  actor: VerifiedActorAuthInfo,
  rawInput: unknown,
  requestId: string,
  options: ArtifactOptions,
): ArtifactRecord {
  const input = parseInput(rawInput);
  const context = actorContext(db, actor, input, options);
  const hash = requestHash(input);
  const replay = readIdempotency(db, actor.actorId, input.idempotency_key, hash, input.lease);
  if (replay !== undefined) return replay;
  const job = loadJob(db, input.job_id);
  const platform = platformOf(options);
  const sourceRoot = context.lease === undefined
    ? job.workspace
    : artifactStagingDirectory(options.artifactsRoot, input.job_id, input.cycle, input.run_id!, platform);
  let source: string;
  try {
    source = sourceFile(sourceRoot, input.source_path, platform);
  } catch (cause) {
    if (cause instanceof ArtifactError) {
      recordArtifactRejection(audit, context, input, requestId, cause);
      throw cause;
    }
    fail('PATH_REJECTED', 'The artifact source is unavailable.');
  }
  const artifactId = randomUUID();
  const path = finalPath(options.artifactsRoot, {
    artifact_id: artifactId,
    job_id: input.job_id,
    cycle: input.cycle,
    run_id: input.run_id ?? null,
  }, safeFileName(input.source_path, platform), platform);
  let storedAbsolutePath: string | undefined;
  try {
    const directory = ensureDirectoryWithinRoot(options.artifactsRoot, dirname(path.absolute), platform);
    const absolute = pathApi(platform).join(directory, pathApi(platform).basename(path.absolute));
    storedAbsolutePath = absolute;
    const root = realpathSync.native(options.artifactsRoot);
    assertNoLinksAtOrBelow(root, directory, platform);
    const copied = copyAndHash(source, absolute);
    const record: ArtifactRecord = {
      artifact_id: artifactId,
      job_id: input.job_id,
      cycle: input.cycle,
      run_id: input.run_id ?? null,
      kind: input.kind,
      mime: input.mime ?? null,
      label: input.label ?? null,
      rel_path: path.relative,
      bytes: copied.bytes,
      sha256: copied.sha256,
      created_by: context.actorId,
      created_at: nowIso(options),
    };
    const result = withImmediateTransaction(db, () => {
      const replayInside = readIdempotency(db, actor.actorId, input.idempotency_key, hash, input.lease);
      if (replayInside !== undefined) return replayInside;
      const inserted = insertArtifactInTransaction(db, audit, input, context, record, requestId, options);
      db.prepare(
        'INSERT INTO idempotency(actor_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(actor.actorId, input.idempotency_key, hash, JSON.stringify(inserted), inserted.created_at);
      return inserted;
    });
    if (result.artifact_id !== record.artifact_id) {
      try { unlinkSync(absolute); } catch { /* best effort after an idempotent replay */ }
    }
    return result;
  } catch (cause) {
    if (storedAbsolutePath !== undefined) {
      try { unlinkSync(storedAbsolutePath); } catch { /* best effort cleanup */ }
    }
    if (cause instanceof ArtifactError) {
      recordArtifactRejection(audit, context, input, requestId, cause);
      throw cause;
    }
    fail('INTERNAL_ERROR', 'The artifact registration failed.');
  }
}

export function registerRuntimeArtifact(
  db: SqliteDatabase,
  audit: AuditWriter,
  lease: string,
  input: Omit<ArtifactRegisterInput, 'idempotency_key' | 'lease' | 'job_id' | 'cycle' | 'run_id'> & {
    readonly job_id: string;
    readonly cycle: number;
    readonly run_id: string;
  },
  requestId: string,
  options: ArtifactOptions,
): ArtifactRecord {
  let active: ActiveWorkerLease;
  try {
    active = requireActiveWorkerLease(db, lease, undefined, options);
  } catch (cause) {
    fail('LEASE_INVALID', cause instanceof Error ? cause.message : 'The worker lease is invalid.');
  }
  if (active.payload.job_id !== input.job_id || active.payload.cycle !== input.cycle
    || active.payload.run_id !== input.run_id) {
    fail('LEASE_INVALID', 'The worker lease does not match the runtime artifact.');
  }
  return registerArtifact(
    db,
    audit,
    runtimeActor(active),
    { ...input, lease, idempotency_key: randomUUID() },
    requestId,
    options,
  );
}

function encodeCursor(cursor: Cursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  if (byteLength(encoded) > MAX_CURSOR_BYTES) fail('INVALID_INPUT', 'The artifact cursor exceeds its bound.');
  return encoded;
}

function decodeCursor(value: string, jobId: string, cycle: number | undefined): Cursor {
  if (byteLength(value) > MAX_CURSOR_BYTES) fail('INVALID_INPUT', 'The artifact cursor exceeds its bound.');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('cursor object required');
    const candidate = parsed as Record<string, unknown>;
    if (candidate['version'] !== 1 || candidate['job_id'] !== jobId
      || (candidate['cycle'] !== null && candidate['cycle'] !== cycle)
      || typeof candidate['created_at'] !== 'string' || typeof candidate['artifact_id'] !== 'string') {
      throw new Error('cursor filter mismatch');
    }
    return {
      version: 1,
      job_id: jobId,
      cycle: candidate['cycle'] as number | null,
      created_at: candidate['created_at'],
      artifact_id: candidate['artifact_id'],
    };
  } catch {
    fail('INVALID_INPUT', 'The artifact cursor is invalid.');
  }
}

export function listArtifacts(
  db: SqliteDatabase,
  actor: VerifiedActorAuthInfo,
  rawInput: unknown,
): ArtifactListResult {
  if (!validActor(actor) || (actor.role !== 'principal' && actor.role !== 'observer')
    || !hasCapability(actor.capabilities, 'job:read')) {
    fail('AUTHORIZATION_DENIED', 'The verified actor cannot read artifacts.');
  }
  const parsed = ArtifactListInputSchema.safeParse(rawInput);
  if (!parsed.success) fail('INVALID_INPUT', 'The artifact list input is invalid.');
  const input = parsed.data;
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
    clauses.push('(created_at > ? OR (created_at = ? AND artifact_id > ?))');
    params.push(cursor.created_at, cursor.created_at, cursor.artifact_id);
  }
  const rows = db.prepare(
    `SELECT artifact_id, job_id, cycle, run_id, kind, mime, label, rel_path, bytes, sha256, created_by, created_at
       FROM artifacts WHERE ${clauses.join(' AND ')}
       ORDER BY created_at, artifact_id LIMIT ?`,
  ).all(...params, limit + 1) as ArtifactSqlRow[];
  const hasNext = rows.length > limit;
  const selected = hasNext ? rows.slice(0, limit) : rows;
  const artifacts = selected.map(parseStored);
  if (!hasNext || artifacts.length === 0) return { artifacts };
  const last = artifacts[artifacts.length - 1];
  if (last === undefined) return { artifacts };
  return {
    artifacts,
    next_cursor: encodeCursor({
      version: 1,
      job_id: input.job_id,
      cycle: input.cycle ?? null,
      created_at: last.created_at,
      artifact_id: last.artifact_id,
    }),
  };
}
