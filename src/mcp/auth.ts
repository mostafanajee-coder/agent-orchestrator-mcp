import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo as SdkAuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';

import {
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  CAPABILITY_VALUES,
  type ActorRole,
  type Capability,
} from '../authority/capabilities.js';

/** Authentication data the Phase 2 boundary exposes to the core. */
export interface ActorAuthInfo {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly tokenId: string;
  readonly sessionLabel: string;
  readonly expiresAt: number;
  /** Present for the Phase 4 persistent resolver; absent on legacy fixtures. */
  readonly actorId?: string;
  readonly role?: ActorRole;
  readonly capabilities?: readonly Capability[];
}

export interface VerifiedActorAuthInfo extends ActorAuthInfo {
  readonly actorId: string;
  readonly role: ActorRole;
  readonly capabilities: readonly Capability[];
}

/** The Phase 3-compatible shape of an actor token, without plaintext. */
export interface ActorTokenRecord {
  readonly tokenId: string;
  readonly actorId: string;
  readonly tokenSha256: string;
  readonly scopes: readonly string[];
  readonly sessionLabel: string;
  readonly disabled?: boolean;
  readonly expiresAt: number;
}

/** Narrow token-resolution interface shared by HTTP and stdio. */
export interface AccessTokenResolver {
  verifyAccessToken(token: string): Promise<ActorAuthInfo>;
}

export class AuthConfigurationError extends Error {
  public override readonly name = 'AuthConfigurationError';
}

const TOKEN_DIGEST = /^[0-9a-f]{64}$/i;
const NEVER_EXPIRES_SECONDS = Number.MAX_SAFE_INTEGER / 1000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Hashes a token without retaining or displaying its plaintext. */
export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function invalidToken(): never {
  throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
}

function requireLabel(value: string, field: string): string {
  const label = value.trim();
  if (label === '' || label.length > 256) {
    throw new AuthConfigurationError(`${field} must be a non-empty value of at most 256 characters.`);
  }
  return label;
}

function prepareRecord(record: ActorTokenRecord): {
  readonly record: ActorTokenRecord;
  readonly digest: Buffer;
} {
  const tokenSha256 = record.tokenSha256.trim().toLowerCase();
  if (!TOKEN_DIGEST.test(tokenSha256)) {
    throw new AuthConfigurationError(`${record.tokenId} has an invalid token_sha256 value.`);
  }
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= 0) {
    throw new AuthConfigurationError(`${record.tokenId} has an invalid expiration time.`);
  }
  const tokenId = requireLabel(record.tokenId, 'tokenId');
  const actorId = requireLabel(record.actorId, 'actorId');
  const sessionLabel = requireLabel(record.sessionLabel, 'sessionLabel');
  if (
    record.scopes.length === 0 ||
    record.scopes.some((scope) => typeof scope !== 'string' || scope.trim() === '')
  ) {
    throw new AuthConfigurationError(`${tokenId} must have at least one non-empty scope.`);
  }

  const prepared: ActorTokenRecord = {
    tokenId,
    actorId,
    tokenSha256,
    scopes: [...record.scopes],
    sessionLabel,
    ...(record.disabled === true ? { disabled: true } : {}),
    expiresAt: record.expiresAt,
  };
  return { record: prepared, digest: Buffer.from(tokenSha256, 'hex') };
}

function resolveToken(
  token: string,
  records: readonly { readonly record: ActorTokenRecord; readonly digest: Buffer }[],
  clock: () => number,
): ActorAuthInfo {
  const presented = Buffer.from(hashAccessToken(token), 'hex');
  let matched: ActorTokenRecord | undefined;

  // Compare every configured digest so an unknown token does not select a
  // fast path based on a plaintext lookup. Only digests are retained.
  for (const candidate of records) {
    const equal =
      candidate.digest.length === presented.length && timingSafeEqual(candidate.digest, presented);
    if (equal) matched = candidate.record;
  }

  if (matched === undefined || matched.disabled === true || matched.expiresAt <= clock()) {
    invalidToken();
  }

  return {
    clientId: matched.actorId,
    scopes: [...matched.scopes],
    tokenId: matched.tokenId,
    sessionLabel: matched.sessionLabel,
    expiresAt: matched.expiresAt,
  };
}

/**
 * A non-persistent Phase 2 resolver. Production persistence is deliberately
 * deferred to the Phase 3 actor_tokens table; this fixture stores hashes only.
 */
export function createInMemoryTokenResolver(
  records: readonly ActorTokenRecord[],
  clock: () => number = nowSeconds,
): AccessTokenResolver {
  const prepared = records.map(prepareRecord);
  const seenDigests = new Set<string>();
  for (const candidate of prepared) {
    if (seenDigests.has(candidate.record.tokenSha256)) {
      throw new AuthConfigurationError('Token records must not contain duplicate token digests.');
    }
    seenDigests.add(candidate.record.tokenSha256);
  }
  return {
    async verifyAccessToken(token: string): Promise<ActorAuthInfo> {
      return resolveToken(token, prepared, clock);
    },
  };
}

function requiredEnvironmentToken(environment: Readonly<Record<string, string | undefined>>): string {
  const token = environment['ORCHESTRATOR_ACTOR_TOKEN'];
  if (token === undefined || token.trim() === '') {
    throw new AuthConfigurationError(
      'ORCHESTRATOR_ACTOR_TOKEN is required before an MCP transport can serve.',
    );
  }
  if (/\s/.test(token)) {
    throw new AuthConfigurationError('ORCHESTRATOR_ACTOR_TOKEN must not contain whitespace.');
  }
  return token;
}

/** Reads only the stdio bearer value; identity fields never come from env. */
export function readEnvironmentToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return requiredEnvironmentToken(environment);
}

function environmentTokenMaterial(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly token: string; readonly record: ActorTokenRecord } {
  const token = requiredEnvironmentToken(environment);
  const actorId = requireLabel(environment['ORCHESTRATOR_ACTOR_ID'] ?? 'codex', 'actorId');
  const sessionLabel = requireLabel(
    environment['ORCHESTRATOR_SESSION_LABEL'] ?? 'environment-session',
    'sessionLabel',
  );
  const tokenId = requireLabel(
    environment['ORCHESTRATOR_TOKEN_ID'] ?? `environment-${randomUUID()}`,
    'tokenId',
  );
  const expiresAtValue = environment['ORCHESTRATOR_ACTOR_TOKEN_EXPIRES_AT'];
  const expiresAt =
    expiresAtValue === undefined || expiresAtValue.trim() === ''
      ? NEVER_EXPIRES_SECONDS
      : Number(expiresAtValue);

  return {
    token,
    record: {
      tokenId,
      actorId,
      tokenSha256: hashAccessToken(token),
      scopes: ['mcp'],
      sessionLabel,
      expiresAt,
    },
  };
}

/**
 * Builds the Phase 2 environment-backed resolver. The environment token is
 * immediately reduced to a SHA-256 digest and is never persisted.
 */
export function createEnvironmentTokenResolver(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  clock: () => number = nowSeconds,
): AccessTokenResolver {
  const { record } = environmentTokenMaterial(environment);
  return createInMemoryTokenResolver([record], clock);
}

/** Resolves the stdio startup token once, returning only non-secret identity data. */
export function authenticateEnvironmentToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  clock: () => number = nowSeconds,
): ActorAuthInfo {
  const { token, record } = environmentTokenMaterial(environment);
  return resolveToken(token, [prepareRecord(record)], clock);
}

/** Adapts the local boundary to the official SDK bearer-verifier interface. */
export function createSdkTokenVerifier(resolver: AccessTokenResolver): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<SdkAuthInfo> {
      const auth = await resolver.verifyAccessToken(token);
      return {
        token,
        clientId: auth.clientId,
        scopes: [...auth.scopes],
        expiresAt: auth.expiresAt,
        extra: {
          tokenId: auth.tokenId,
          sessionLabel: auth.sessionLabel,
          ...(auth.actorId === undefined ? {} : { actorId: auth.actorId }),
          ...(auth.role === undefined ? {} : { role: auth.role }),
          ...(auth.capabilities === undefined ? {} : { capabilities: [...auth.capabilities] }),
        },
      };
    },
  };
}

/** Recovers the Phase 2 identity fields from an SDK handler context. */
export function actorAuthInfoFromSdk(auth: SdkAuthInfo): ActorAuthInfo {
  const extra = auth.extra ?? {};
  const tokenId = typeof extra['tokenId'] === 'string' ? extra['tokenId'] : 'sdk-token';
  const sessionLabel =
    typeof extra['sessionLabel'] === 'string' ? extra['sessionLabel'] : auth.clientId;
  const expiresAt = auth.expiresAt;
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
    throw new AuthConfigurationError('The verified SDK auth context has no valid expiration time.');
  }
  const actorId = typeof extra['actorId'] === 'string' ? extra['actorId'] : undefined;
  const role = extra['role'];
  const parsedRole =
    role === 'principal' || role === 'worker' || role === 'observer' || role === 'system'
      ? role
      : undefined;
  const rawCapabilities = extra['capabilities'];
  let capabilities = Array.isArray(rawCapabilities)
    && rawCapabilities.every(
      (value): value is Capability =>
        typeof value === 'string' && (CAPABILITY_VALUES as readonly string[]).includes(value),
    )
    ? [...rawCapabilities]
    : undefined;
  if (
    capabilities !== undefined
    && (canonicalCapabilitiesJson(capabilities) !== JSON.stringify(capabilities)
      || parsedRole === undefined)
  ) {
    capabilities = undefined;
  }
  if (capabilities !== undefined && parsedRole !== undefined) {
    try {
      assertRoleCapabilities(parsedRole, capabilities);
    } catch {
      capabilities = undefined;
    }
  }
  return {
    clientId: auth.clientId,
    scopes: [...auth.scopes],
    tokenId,
    sessionLabel,
    expiresAt,
    ...(actorId === undefined ? {} : { actorId }),
    ...(parsedRole === undefined ? {} : { role: parsedRole }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}
