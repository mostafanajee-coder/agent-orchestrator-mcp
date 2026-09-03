import type { VerifiedActorAuthInfo } from '../mcp/auth.js';

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
  return value === 'principal' || value === 'worker' || value === 'observer' || value === 'system';
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
