import { randomUUID } from 'node:crypto';

import {
  OAuthError,
  OAuthErrorCode,
} from '@modelcontextprotocol/server';

import {
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  parseCapabilities,
  type ActorRole,
  type Capability,
} from '../authority/capabilities.js';
import type { AuditWriter } from '../authority/audit.js';
import type { SqliteDatabase } from '../store/db.js';
import { withImmediateTransaction } from '../store/db.js';
import type { AccessTokenResolver, ActorAuthInfo, VerifiedActorAuthInfo } from './auth.js';
import { hashAccessToken } from './auth.js';

const TOKEN_DIGEST = /^[0-9a-f]{64}$/i;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const NEVER_EXPIRES_SECONDS = Number.MAX_SAFE_INTEGER / 1000;

interface PersistentTokenRow {
  readonly token_id: unknown;
  readonly actor_id: unknown;
  readonly token_sha256: unknown;
  readonly label: unknown;
  readonly token_disabled: unknown;
  readonly expires_at: unknown;
  readonly actor_disabled: unknown;
  readonly role: unknown;
  readonly capabilities_json: unknown;
}

export interface PersistentTokenResolverOptions {
  readonly clock?: () => number;
  readonly audit?: AuditWriter;
}

function invalidToken(): never {
  throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function role(value: unknown): ActorRole | undefined {
  return value === 'principal' || value === 'worker' || value === 'observer' || value === 'system'
    ? value
    : undefined;
}

function validExpiry(value: unknown, nowMs: number): number {
  if (value === null) return NEVER_EXPIRES_SECONDS;
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)) invalidToken();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalidToken();
  if (milliseconds <= nowMs) invalidToken();
  return Math.floor(milliseconds / 1000);
}

function recordRejection(audit: AuditWriter | undefined): void {
  if (audit === undefined) return;
  try {
    audit.recordRejectedAuth(randomUUID(), { reason: 'invalid_token' });
  } catch {
    // Authentication failure must not be replaced by an audit-side failure.
  }
}

export class PersistentTokenResolver implements AccessTokenResolver {
  private readonly clock: () => number;

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly options: PersistentTokenResolverOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
  }

  public verifyAccessToken(token: string): Promise<ActorAuthInfo> {
    try {
      return Promise.resolve(this.verifyAccessTokenSync(token));
    } catch (cause) {
      return Promise.reject(cause);
    }
  }

  /** Synchronous form used before the stdio transport is created. */
  public verifyAccessTokenSync(token: string): VerifiedActorAuthInfo {
    try {
      const nowMs = this.clock();
      if (!Number.isFinite(nowMs)) invalidToken();
      if (typeof token !== 'string' || token.trim() === '' || /\s/.test(token)) invalidToken();
      const digest = hashAccessToken(token);
      return withImmediateTransaction(this.db, () => {
        const row = this.db.prepare(
          'SELECT t.token_id, t.actor_id, t.token_sha256, t.label, t.disabled AS token_disabled, t.expires_at, a.disabled AS actor_disabled, a.role, a.capabilities_json FROM actor_tokens t JOIN actors a ON a.actor_id = t.actor_id WHERE lower(t.token_sha256) = ?',
        ).get(digest) as PersistentTokenRow | undefined;
        if (row === undefined) invalidToken();

        const actorId = text(row.actor_id);
        const tokenId = text(row.token_id);
        const label = text(row.label);
        const storedDigest = text(row.token_sha256)?.toLowerCase();
        const actorRole = role(row.role);
        if (
          actorId === undefined
          || tokenId === undefined
          || label === undefined
          || storedDigest === undefined
          || !TOKEN_DIGEST.test(storedDigest)
          || actorRole === undefined
          || (row.token_disabled !== 0 && row.token_disabled !== 1)
          || (row.actor_disabled !== 0 && row.actor_disabled !== 1)
          || row.token_disabled === 1
          || row.actor_disabled === 1
          || actorRole === 'system'
          || actorId === 'system'
        ) {
          invalidToken();
        }

        const rawCapabilities = text(row.capabilities_json);
        if (rawCapabilities === undefined) invalidToken();
        let capabilities: Capability[];
        try {
          capabilities = parseCapabilities(rawCapabilities);
          assertRoleCapabilities(actorRole, capabilities);
        } catch {
          invalidToken();
        }
        if (canonicalCapabilitiesJson(capabilities) !== rawCapabilities) invalidToken();
        const expiresAt = validExpiry(row.expires_at, nowMs);
        const lastUsedAt = new Date(nowMs).toISOString();
        const updated = this.db.prepare(
          'UPDATE actor_tokens SET last_used_at = ? WHERE token_id = ? AND disabled = 0',
        ).run(lastUsedAt, tokenId);
        if (updated.changes !== 1) invalidToken();

        return {
          clientId: actorId,
          actorId,
          role: actorRole,
          capabilities,
          // `mcp` is the transport marker required by the SDK bearer gate.
          // Application authority comes only from the explicit capabilities.
          scopes: ['mcp'],
          tokenId,
          sessionLabel: label,
          expiresAt,
        };
      });
    } catch (cause) {
      if (cause instanceof OAuthError) {
        if (cause.code === OAuthErrorCode.InvalidToken) recordRejection(this.options.audit);
        throw cause;
      }
      throw new OAuthError(OAuthErrorCode.ServerError, 'Authentication service unavailable');
    }
  }
}

export function createPersistentTokenResolver(
  db: SqliteDatabase,
  options: PersistentTokenResolverOptions = {},
): PersistentTokenResolver {
  return new PersistentTokenResolver(db, options);
}
