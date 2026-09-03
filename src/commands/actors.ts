import { randomUUID } from 'node:crypto';

import type { CommandContext } from './context.js';
import { openPhase4ManagementRuntime } from '../authority/runtime.js';
import {
  allowedCapabilitiesForRole,
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  type Capability,
} from '../authority/capabilities.js';
import { validatePhase4State } from '../authority/state.js';
import { withImmediateTransaction } from '../store/db.js';
import { UsageError } from '../errors.js';

const MAX_ACTOR_ID_BYTES = 64;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OBSERVER_DISPLAY_NAME = 'ChatGPT Edge Reader';

export type ActorCommandOptions = {
  readonly action: 'create';
  readonly actorId: string;
  readonly role: 'observer';
};

export interface ActorCommandResult {
  readonly action: 'create';
  readonly actorId: string;
  readonly role: 'observer';
  readonly capabilities: readonly Capability[];
}

function boundedActorId(value: string): string {
  const actorId = value.trim();
  if (
    actorId === ''
    || Buffer.byteLength(actorId, 'utf8') > MAX_ACTOR_ID_BYTES
    || !ACTOR_ID_PATTERN.test(actorId)
    || actorId === 'codex'
    || actorId === 'system'
  ) {
    throw new UsageError(
      'actor-id must be a non-reserved ASCII identity of at most 64 bytes',
    );
  }
  return actorId;
}

function createObserverActor(
  runtime: ReturnType<typeof openPhase4ManagementRuntime>,
  actorId: string,
  nowMs: number,
): ActorCommandResult {
  const role = 'observer' as const;
  const capabilities = allowedCapabilitiesForRole(role);
  assertRoleCapabilities(role, capabilities);
  const capabilitiesJson = canonicalCapabilitiesJson(capabilities);
  const createdAt = new Date(nowMs).toISOString();

  withImmediateTransaction(runtime.db, () => {
    validatePhase4State(runtime.db, nowMs, { requireUsableToken: false });
    const existing = runtime.db.prepare(
      'SELECT actor_id FROM actors WHERE actor_id = ?',
    ).get(actorId) as { readonly actor_id?: unknown } | undefined;
    if (existing !== undefined) {
      throw new UsageError('actor-id already exists; no actor was changed');
    }

    runtime.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(actorId, role, OBSERVER_DISPLAY_NAME, capabilitiesJson, 0, createdAt);
    runtime.audit.appendInTransaction({
      actorId: 'system',
      actorRole: 'system',
      requestId: randomUUID(),
      action: 'actor.created',
      subjectType: 'actor',
      subjectId: actorId,
      result: 'ok',
      detail: { actor_id: actorId, role, capabilities },
      timestamp: createdAt,
    });
    validatePhase4State(runtime.db, nowMs, { requireUsableToken: false });
  });

  return { action: 'create', actorId, role, capabilities };
}

/** Creates only a read-only observer through the local operator CLI path. */
export function runActorCommand(
  context: CommandContext,
  options: ActorCommandOptions,
  now = () => Date.now(),
): ActorCommandResult {
  if (Object.prototype.hasOwnProperty.call(options, 'capabilities')) {
    throw new UsageError('actor create does not accept caller-supplied capabilities');
  }
  if (options.action !== 'create' || options.role !== 'observer') {
    throw new UsageError('actor create supports only the observer role');
  }
  const actorId = boundedActorId(options.actorId);
  const nowMs = now();
  if (!Number.isFinite(nowMs)) throw new UsageError('the system clock is invalid');

  const runtime = openPhase4ManagementRuntime(context);
  try {
    return createObserverActor(runtime, actorId, nowMs);
  } finally {
    runtime.close();
  }
}
