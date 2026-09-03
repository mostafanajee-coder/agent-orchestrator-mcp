import { randomBytes, randomUUID } from 'node:crypto';

import type { CommandContext } from './context.js';
import { openPhase4ManagementRuntime } from '../authority/runtime.js';
import { validatePhase4State } from '../authority/state.js';
import { assertRoleCapabilities, canonicalCapabilitiesJson, parseCapabilities } from '../authority/capabilities.js';
import { hashAccessToken } from '../mcp/auth.js';
import { withImmediateTransaction } from '../store/db.js';
import { UsageError } from '../errors.js';

const MAX_LABEL_LENGTH = 256;
const MAX_ACTOR_ID_BYTES = 64;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type TokenCommandOptions =
  | {
      readonly action: 'issue';
      readonly label: string;
      readonly expiresAt?: string;
      readonly actorId?: string;
    }
  | {
      readonly action: 'list';
    }
  | {
      readonly action: 'revoke';
      readonly tokenId: string;
    };

export interface TokenListItem {
  readonly tokenId: string;
  readonly actorId: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface TokenCommandResult {
  readonly action: TokenCommandOptions['action'];
  readonly tokenId?: string;
  readonly actorId?: string;
  readonly label?: string;
  readonly expiresAt?: string | null;
  /** The plaintext is returned only to the explicit CLI renderer. */
  readonly plaintext?: string;
  readonly tokens?: readonly TokenListItem[];
  readonly revoked?: boolean;
}

interface TokenSqlRow {
  readonly token_id: unknown;
  readonly actor_id: unknown;
  readonly label: unknown;
  readonly disabled: unknown;
  readonly expires_at: unknown;
  readonly last_used_at: unknown;
  readonly created_at: unknown;
}

function boundedText(value: string, field: string): string {
  const trimmed = value.trim();
  if (
    trimmed === ''
    || trimmed.length > MAX_LABEL_LENGTH
    || /[\r\n]/.test(trimmed)
  ) {
    throw new UsageError(`${field} must be a non-empty single-line value of at most 256 characters`);
  }
  return trimmed;
}

function boundedActorId(value: string): string {
  const actorId = value.trim();
  if (
    actorId === ''
    || Buffer.byteLength(actorId, 'utf8') > MAX_ACTOR_ID_BYTES
    || !ACTOR_ID_PATTERN.test(actorId)
  ) {
    throw new UsageError('actor-id must be a non-empty ASCII identity of at most 64 bytes');
  }
  return actorId;
}

function normalizeExpiry(value: string | undefined, nowMs: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (!RFC3339_UTC.test(trimmed) || !Number.isFinite(parsed) || parsed <= nowMs) {
    throw new UsageError('expires-at must be a future RFC3339 UTC timestamp ending in Z');
  }
  return new Date(parsed).toISOString();
}

function createToken(): { readonly plaintext: string; readonly digest: string } {
  const plaintext = randomBytes(32).toString('base64url');
  return { plaintext, digest: hashAccessToken(plaintext) };
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('The stored ' + field + ' is malformed.');
  }
  return value;
}

function tokenListItem(row: TokenSqlRow): TokenListItem {
  if (row.disabled !== 0 && row.disabled !== 1) {
    throw new Error('The stored token disabled state is malformed.');
  }
  if (row.expires_at !== null && typeof row.expires_at !== 'string') {
    throw new Error('The stored token expiry is malformed.');
  }
  if (row.last_used_at !== null && typeof row.last_used_at !== 'string') {
    throw new Error('The stored token last-used timestamp is malformed.');
  }
  return {
    tokenId: text(row.token_id, 'token identity'),
    actorId: text(row.actor_id, 'token actor identity'),
    label: text(row.label, 'token label'),
    disabled: row.disabled === 1,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: text(row.created_at, 'token creation timestamp'),
  };
}

function issueToken(
  runtime: ReturnType<typeof openPhase4ManagementRuntime>,
  label: string,
  expiresAt: string | null,
  actorId: string,
  nowMs: number,
): TokenCommandResult {
  const token = createToken();
  const tokenId = 'token-' + randomUUID();
  const createdAt = new Date(nowMs).toISOString();
  withImmediateTransaction(runtime.db, () => {
    validatePhase4State(runtime.db, nowMs, { requireUsableToken: false });
    const actor = runtime.db.prepare(
      'SELECT actor_id, role, disabled, capabilities_json FROM actors WHERE actor_id = ?',
    ).get(actorId) as {
      readonly actor_id?: unknown;
      readonly role?: unknown;
      readonly disabled?: unknown;
      readonly capabilities_json?: unknown;
    } | undefined;
    if (actor === undefined || actor.actor_id !== actorId) {
      throw new UsageError('the requested actor does not exist');
    }
    if (actor.disabled !== 0) throw new UsageError('the requested actor is disabled');
    if (actorId !== 'codex') {
      if (actor.role !== 'observer' || typeof actor.capabilities_json !== 'string') {
        throw new UsageError('token issue --actor-id supports only codex or observer actors');
      }
      const capabilities = parseCapabilities(actor.capabilities_json);
      assertRoleCapabilities('observer', capabilities);
      if (canonicalCapabilitiesJson(capabilities) !== '["job:read"]') {
        throw new UsageError('the observer actor must have only job:read');
      }
    } else if (actor.role !== 'principal') {
      throw new UsageError('the codex token target is not a principal');
    }
    runtime.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(tokenId, actorId, token.digest, label, 0, expiresAt, null, createdAt);
    runtime.audit.appendInTransaction({
      actorId: 'system',
      actorRole: 'system',
      requestId: randomUUID(),
      action: 'token.issued',
      subjectType: 'actor_token',
      subjectId: tokenId,
      result: 'ok',
      detail: { token_id: tokenId, actor_id: actorId, label, expires_at: expiresAt },
      timestamp: createdAt,
    });
    validatePhase4State(runtime.db, nowMs, { requireUsableToken: false });
  });
  return {
    action: 'issue',
    tokenId,
    actorId,
    label,
    expiresAt,
    plaintext: token.plaintext,
  };
}

function listTokens(
  runtime: ReturnType<typeof openPhase4ManagementRuntime>,
): TokenCommandResult {
  const rows = runtime.db.prepare(
    'SELECT token_id, actor_id, label, disabled, expires_at, last_used_at, created_at FROM actor_tokens ORDER BY token_id',
  ).all() as TokenSqlRow[];
  return { action: 'list', tokens: rows.map(tokenListItem) };
}

function revokeToken(
  runtime: ReturnType<typeof openPhase4ManagementRuntime>,
  tokenId: string,
  nowMs: number,
): TokenCommandResult {
  const timestamp = new Date(nowMs).toISOString();
  let revoked = false;
  let label = '';
  withImmediateTransaction(runtime.db, () => {
    validatePhase4State(runtime.db, nowMs, { requireUsableToken: false });
    const row = runtime.db.prepare(
      'SELECT actor_id, label, disabled FROM actor_tokens WHERE token_id = ?',
    ).get(tokenId) as { readonly actor_id?: unknown; readonly label?: unknown; readonly disabled?: unknown } | undefined;
    if (row === undefined) {
      throw new UsageError('the requested token-id does not exist');
    }
    if (row.actor_id === 'system') {
      throw new UsageError('the internal system actor cannot have a transport token');
    }
    if (row.disabled !== 0 && row.disabled !== 1) {
      throw new Error('The stored token disabled state is malformed.');
    }
    label = text(row.label, 'token label');
    if (row.disabled === 1) return;
    const update = runtime.db.prepare(
      'UPDATE actor_tokens SET disabled = 1 WHERE token_id = ? AND disabled = 0',
    ).run(tokenId);
    if (update.changes !== 1) throw new Error('The token changed before revocation completed.');
    runtime.audit.appendInTransaction({
      actorId: 'system',
      actorRole: 'system',
      requestId: randomUUID(),
      action: 'token.revoked',
      subjectType: 'actor_token',
      subjectId: tokenId,
      result: 'ok',
      detail: { token_id: tokenId, label },
      timestamp,
    });
    revoked = true;
  });
  return { action: 'revoke', tokenId, revoked };
}

export function runTokenCommand(
  context: CommandContext,
  options: TokenCommandOptions,
  now = () => Date.now(),
): TokenCommandResult {
  const nowMs = now();
  if (!Number.isFinite(nowMs)) throw new UsageError('the system clock is invalid');

  if (options.action === 'issue') {
    const label = boundedText(options.label, 'label');
    const expiresAt = normalizeExpiry(options.expiresAt, nowMs);
    const actorId = options.actorId === undefined ? 'codex' : boundedActorId(options.actorId);
    const runtime = openPhase4ManagementRuntime(context);
    try {
      return issueToken(runtime, label, expiresAt, actorId, nowMs);
    } finally {
      runtime.close();
    }
  }

  const runtime = openPhase4ManagementRuntime(context);
  try {
    if (options.action === 'list') return listTokens(runtime);
    return revokeToken(runtime, boundedText(options.tokenId, 'token-id'), nowMs);
  } finally {
    runtime.close();
  }
}
