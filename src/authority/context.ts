import type { ActorAuthInfo, VerifiedActorAuthInfo } from '../mcp/auth.js';

import {
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  CAPABILITY_VALUES,
  type ActorRole,
  type Capability,
} from './capabilities.js';

export const AUTHORIZATION_MODE_VALUES = ['direct', 'delegated'] as const;
export type AuthorizationMode = (typeof AUTHORIZATION_MODE_VALUES)[number];

export const AUTHORIZATION_SOURCE_VALUES = ['authenticated-actor'] as const;
export type AuthorizationSource = (typeof AUTHORIZATION_SOURCE_VALUES)[number];

export interface AuthorizationProvenance {
  readonly transportActorId: string;
  readonly sessionTokenId: string;
  readonly sessionLabel: string;
  readonly authorizationSource: AuthorizationSource;
  readonly integrationId?: string;
  readonly integrationGeneration?: number;
}

/** Internal metadata attached by the persistent resolver for edge actors. */
export interface EdgeAuthenticationInfo {
  readonly integrationId?: string;
  readonly integrationGeneration?: number;
}

const AUTHORIZATION_CONTEXT_BRAND = Symbol('AuthorizationContext');
const TRUSTED_CONTEXTS = new WeakSet<object>();
const IDENTIFIER_MAX_LENGTH = 256;

/**
 * Normalized authorization facts produced after the authentication boundary.
 * It contains no bearer, HTTP header, OAuth, Funnel, or client-network data.
 * The private brand and frozen nested values prevent ordinary callers from
 * manufacturing or mutating a trusted context through the public type.
 */
export interface AuthorizationContext {
  readonly [AUTHORIZATION_CONTEXT_BRAND]: true;
  readonly transportActorId: string;
  readonly transportRole: ActorRole;
  readonly effectivePrincipalId: 'codex' | null;
  readonly effectiveCapabilities: readonly Capability[];
  readonly authMode: AuthorizationMode;
  readonly authorizationSource: AuthorizationSource;
  readonly provenance: AuthorizationProvenance;
  readonly expiresAt: number;
  readonly integrationId: string | null;
  readonly integrationGeneration: number | null;
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= IDENTIFIER_MAX_LENGTH
    && value.trim() !== ''
    && !/[\r\n\0]/.test(value);
}

function isActorRole(value: unknown): value is ActorRole {
  return value === 'principal'
    || value === 'worker'
    || value === 'observer'
    || value === 'system'
    || value === 'edge';
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string'
    && (CAPABILITY_VALUES as readonly string[]).includes(value);
}

function validCapabilitySet(role: ActorRole, value: unknown): value is readonly Capability[] {
  if (!Array.isArray(value) || !value.every(isCapability)) return false;
  try {
    assertRoleCapabilities(role, value);
  } catch {
    return false;
  }
  return canonicalCapabilitiesJson(value) === JSON.stringify(value);
}

function validPrincipalProjection(
  actorId: string,
  role: ActorRole,
  effectivePrincipalId: unknown,
): effectivePrincipalId is 'codex' | null {
  const expected = actorId === 'codex' && role === 'principal' ? 'codex' : null;
  return effectivePrincipalId === expected;
}

function validEdgeMetadata(
  role: ActorRole,
  integrationId: unknown,
  integrationGeneration: unknown,
): boolean {
  if (role !== 'edge') return integrationId === null && integrationGeneration === null;
  return boundedText(integrationId)
    && Number.isSafeInteger(integrationGeneration)
    && (integrationGeneration as number) >= 0;
}

/**
 * Checks the runtime invariants of a context created by this module. A
 * delegated-shaped value is never accepted as a trusted direct context; the
 * policy layer separately reports that future delegated mode is disabled.
 */
export function isTrustedAuthorizationContext(value: unknown): value is AuthorizationContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AuthorizationContext> & {
    readonly [AUTHORIZATION_CONTEXT_BRAND]?: unknown;
  };
  if (candidate[AUTHORIZATION_CONTEXT_BRAND] !== true || !TRUSTED_CONTEXTS.has(value)) return false;
  if (!Object.isFrozen(value)
    || !Object.isFrozen(candidate.effectiveCapabilities)
    || !Object.isFrozen(candidate.provenance)) return false;
  if (!boundedText(candidate.transportActorId)
    || !isActorRole(candidate.transportRole)
    || candidate.authMode !== 'direct'
    || candidate.authorizationSource !== 'authenticated-actor'
    || !Number.isFinite(candidate.expiresAt)
    || (candidate.expiresAt as number) <= 0
    || !validEdgeMetadata(
      candidate.transportRole,
      candidate.integrationId,
      candidate.integrationGeneration,
    )
    || !validPrincipalProjection(
      candidate.transportActorId,
      candidate.transportRole,
      candidate.effectivePrincipalId,
    )
    || !validCapabilitySet(candidate.transportRole, candidate.effectiveCapabilities)) {
    return false;
  }

  const provenance = candidate.provenance;
  return typeof provenance === 'object'
    && provenance !== null
    && provenance.transportActorId === candidate.transportActorId
    && boundedText(provenance.sessionTokenId)
    && boundedText(provenance.sessionLabel)
    && provenance.authorizationSource === 'authenticated-actor'
    && (candidate.transportRole !== 'edge'
      || (provenance.integrationId === candidate.integrationId
        && provenance.integrationGeneration === candidate.integrationGeneration));
}

/**
 * Converts verified authentication output into the sole current context
 * representation. The mode is always direct here; no delegated evidence can
 * be supplied by a transport or MCP parameter.
 */
export function createDirectAuthorizationContext(
  authInfo: ActorAuthInfo | undefined,
): AuthorizationContext | undefined {
  const edgeInfo = authInfo as (ActorAuthInfo & EdgeAuthenticationInfo) | undefined;
  const integrationId = authInfo?.role === 'edge' ? edgeInfo?.integrationId ?? null : null;
  const integrationGeneration = authInfo?.role === 'edge'
    ? edgeInfo?.integrationGeneration ?? null
    : null;
  if (authInfo === undefined
    || !boundedText(authInfo.clientId)
    || !boundedText(authInfo.actorId)
    || authInfo.clientId !== authInfo.actorId
    || !isActorRole(authInfo.role)
    || !boundedText(authInfo.tokenId)
    || !boundedText(authInfo.sessionLabel)
    || !Number.isFinite(authInfo.expiresAt)
    || authInfo.expiresAt <= 0
    || !validCapabilitySet(authInfo.role, authInfo.capabilities)
    || !validEdgeMetadata(authInfo.role, integrationId, integrationGeneration)) {
    return undefined;
  }

  const effectiveCapabilities = Object.freeze([...authInfo.capabilities]);
  const provenance = Object.freeze({
    transportActorId: authInfo.actorId,
    sessionTokenId: authInfo.tokenId,
    sessionLabel: authInfo.sessionLabel,
    authorizationSource: 'authenticated-actor' as const,
    ...(authInfo.role === 'edge'
      ? {
        integrationId: integrationId as string,
        integrationGeneration: integrationGeneration as number,
      }
      : {}),
  });
  const context: AuthorizationContext = {
    [AUTHORIZATION_CONTEXT_BRAND]: true,
    transportActorId: authInfo.actorId,
    transportRole: authInfo.role,
    effectivePrincipalId: authInfo.actorId === 'codex' && authInfo.role === 'principal'
      ? 'codex'
      : null,
    effectiveCapabilities,
    authMode: 'direct',
    authorizationSource: 'authenticated-actor',
    provenance,
    expiresAt: authInfo.expiresAt,
    integrationId,
    integrationGeneration,
  };
  const frozenContext = Object.freeze(context);
  TRUSTED_CONTEXTS.add(frozenContext);
  return frozenContext;
}

/**
 * Adapts trusted direct facts to the legacy domain actor shape. Domain code
 * receives this normalized projection, never raw transport/OAuth material.
 */
export function actorAuthInfoFromAuthorizationContext(
  context: AuthorizationContext | undefined,
): VerifiedActorAuthInfo | undefined {
  if (!isTrustedAuthorizationContext(context)) return undefined;
  const capabilities = Object.freeze([...context.effectiveCapabilities]);
  return Object.freeze({
    clientId: context.transportActorId,
    scopes: Object.freeze(['mcp']),
    tokenId: context.provenance.sessionTokenId,
    sessionLabel: context.provenance.sessionLabel,
    expiresAt: context.expiresAt,
    actorId: context.transportActorId,
    role: context.transportRole,
    capabilities,
  });
}
