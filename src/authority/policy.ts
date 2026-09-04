import type { VerifiedActorAuthInfo } from '../mcp/auth.js';
import type { AuthorizationReadiness } from './authorizationState.js';

import {
  actorAuthInfoFromAuthorizationContext,
  isTrustedAuthorizationContext,
  type AuthorizationContext,
} from './context.js';
import {
  CAPABILITY_VALUES,
  hasCapability,
  type ActorRole,
  type Capability,
} from './capabilities.js';

export const AUTHORIZATION_DECISION_REASONS = [
  'allowed',
  'missing_context',
  'invalid_context',
  'delegated_mode_disabled',
  'invalid_requirement',
  'role_not_allowed',
  'actor_not_allowed',
  'capability_not_granted',
] as const;
export type AuthorizationDecisionReason = (typeof AUTHORIZATION_DECISION_REASONS)[number];

export const EDGE_ADMISSION_DENIAL_REASONS = [
  'issuance_not_enabled',
  'edge_not_bound',
  'binding_disabled',
  'integration_disabled',
  'generation_mismatch',
  'authorization_state_unready',
  'invalid_context',
  'audit_failure',
] as const;
export type EdgeAdmissionDenialReason = (typeof EDGE_ADMISSION_DENIAL_REASONS)[number];

export const EDGE_ADMISSION_REQUIREMENT: AuthorizationRequirement = Object.freeze({
  capability: 'delegation:request',
  allowedRoles: Object.freeze(['edge'] as const),
});

export interface EdgeAdmissionFacts {
  readonly readiness: AuthorizationReadiness;
  readonly bindingExists: boolean;
  readonly bindingEnabled: boolean;
  readonly boundIntegrationId: string | null;
  readonly integrationExists: boolean;
  readonly integrationEnabled: boolean;
  readonly currentIntegrationId: string | null;
  readonly currentIntegrationGeneration: number | null;
}

export interface EdgeAdmissionDecision {
  readonly allowed: false;
  readonly reason: EdgeAdmissionDenialReason;
}

/** A server-authored operation requirement, never MCP caller input. */
export interface AuthorizationRequirement {
  readonly capability: Capability;
  readonly allowedRoles?: readonly ActorRole[];
  readonly requiredActorId?: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: AuthorizationDecisionReason;
}

export interface AuthorizationPolicy {
  readonly evaluate: (
    context: AuthorizationContext | undefined,
    requirement: AuthorizationRequirement,
  ) => AuthorizationDecision;
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string'
    && (CAPABILITY_VALUES as readonly string[]).includes(value);
}

function isRole(value: unknown): value is ActorRole {
  return value === 'principal'
    || value === 'worker'
    || value === 'observer'
    || value === 'system'
    || value === 'edge';
}

function validRequirement(value: unknown): value is AuthorizationRequirement {
  if (typeof value !== 'object' || value === null) return false;
  const requirement = value as Partial<AuthorizationRequirement>;
  if (!isCapability(requirement.capability)) return false;
  if (requirement.allowedRoles !== undefined
    && (!Array.isArray(requirement.allowedRoles)
      || requirement.allowedRoles.length === 0
      || !requirement.allowedRoles.every(isRole))) return false;
  if (requirement.requiredActorId !== undefined
    && (typeof requirement.requiredActorId !== 'string'
      || requirement.requiredActorId.trim() === ''
      || requirement.requiredActorId.length > 256
      || /[\r\n\0]/.test(requirement.requiredActorId))) return false;
  return true;
}

function rawAuthMode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as { readonly authMode?: unknown }).authMode;
}

/**
 * Evaluates only the current direct actor/capability model. Delegated mode is
 * intentionally recognized and denied before any authority-like field can be
 * considered. Requirements are selected by trusted server code, not callers.
 */
export function evaluateAuthorization(
  context: AuthorizationContext | undefined,
  requirement: AuthorizationRequirement,
): AuthorizationDecision {
  if (rawAuthMode(context) === 'delegated') {
    return { allowed: false, reason: 'delegated_mode_disabled' };
  }
  if (context === undefined) return { allowed: false, reason: 'missing_context' };
  if (!validRequirement(requirement)) {
    return { allowed: false, reason: 'invalid_requirement' };
  }
  if (!isTrustedAuthorizationContext(context)) {
    return { allowed: false, reason: 'invalid_context' };
  }
  if (requirement.allowedRoles !== undefined
    && !requirement.allowedRoles.includes(context.transportRole)) {
    return { allowed: false, reason: 'role_not_allowed' };
  }
  if (requirement.requiredActorId !== undefined
    && requirement.requiredActorId !== context.transportActorId) {
    return { allowed: false, reason: 'actor_not_allowed' };
  }
  if (!hasCapability(context.effectiveCapabilities, requirement.capability)) {
    return { allowed: false, reason: 'capability_not_granted' };
  }
  return { allowed: true, reason: 'allowed' };
}

export const authorizationPolicy: AuthorizationPolicy = Object.freeze({
  evaluate: evaluateAuthorization,
});

function validEdgeFacts(facts: EdgeAdmissionFacts): boolean {
  return typeof facts.bindingExists === 'boolean'
    && typeof facts.bindingEnabled === 'boolean'
    && (facts.boundIntegrationId === null || typeof facts.boundIntegrationId === 'string')
    && typeof facts.integrationExists === 'boolean'
    && typeof facts.integrationEnabled === 'boolean'
    && (facts.currentIntegrationId === null || typeof facts.currentIntegrationId === 'string')
    && (facts.currentIntegrationGeneration === null
      || (Number.isSafeInteger(facts.currentIntegrationGeneration)
        && facts.currentIntegrationGeneration >= 0));
}

/** Evaluates the request-only edge boundary. It is permanently deny-only here. */
export function evaluateEdgeAdmission(
  context: AuthorizationContext | undefined,
  facts: EdgeAdmissionFacts,
): EdgeAdmissionDecision {
  if (!validEdgeFacts(facts)) return { allowed: false, reason: 'invalid_context' };
  const authorization = authorizationPolicy.evaluate(context, EDGE_ADMISSION_REQUIREMENT);
  if (!authorization.allowed) return { allowed: false, reason: 'invalid_context' };
  if (facts.readiness !== 'READY') {
    return { allowed: false, reason: 'authorization_state_unready' };
  }
  if (!facts.bindingExists || facts.boundIntegrationId === null) {
    return { allowed: false, reason: 'edge_not_bound' };
  }
  if (!facts.bindingEnabled) return { allowed: false, reason: 'binding_disabled' };
  if (!facts.integrationExists || facts.currentIntegrationId === null) {
    return { allowed: false, reason: 'edge_not_bound' };
  }
  if (!facts.integrationEnabled) return { allowed: false, reason: 'integration_disabled' };
  if (
    context?.integrationId !== facts.boundIntegrationId
    || facts.currentIntegrationId !== facts.boundIntegrationId
    || context.integrationGeneration === null
    || facts.currentIntegrationGeneration === null
    || context.integrationGeneration !== facts.currentIntegrationGeneration
  ) {
    return { allowed: false, reason: 'generation_mismatch' };
  }
  return { allowed: false, reason: 'issuance_not_enabled' };
}

/**
 * Returns the normalized legacy actor projection only after the policy allows
 * the server-authored requirement. This is the common MCP visibility boundary.
 */
export function actorForRequirement(
  context: AuthorizationContext | undefined,
  requirement: AuthorizationRequirement,
): VerifiedActorAuthInfo | undefined {
  if (!authorizationPolicy.evaluate(context, requirement).allowed) return undefined;
  return actorAuthInfoFromAuthorizationContext(context);
}
