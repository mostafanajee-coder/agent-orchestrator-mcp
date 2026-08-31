import type { SqliteDatabase } from '../store/db.js';

import {
  assertRoleCapabilities,
  canonicalCapabilitiesJson,
  parseCapabilities,
  type ActorRole,
} from './capabilities.js';

const TOKEN_DIGEST = /^[0-9a-f]{64}$/i;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface Phase4StateReport {
  readonly principalActorId: 'codex';
  readonly usableTokenCount: number;
}

export interface Phase4StateValidationOptions {
  /** Token administration may repair a valid actor state with zero usable tokens. */
  readonly requireUsableToken?: boolean;
}

interface ActorSqlRow {
  readonly actor_id: unknown;
  readonly role: unknown;
  readonly capabilities_json: unknown;
  readonly disabled: unknown;
  readonly created_at: unknown;
}

interface TokenSqlRow {
  readonly token_id: unknown;
  readonly actor_id: unknown;
  readonly token_sha256: unknown;
  readonly label: unknown;
  readonly disabled: unknown;
  readonly expires_at: unknown;
  readonly last_used_at: unknown;
  readonly created_at: unknown;
}

export class Phase4StateError extends Error {
  public override readonly name = 'Phase4StateError';
}

function fail(message: string): never {
  throw new Phase4StateError(message);
}

function asText(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || /[\r\n]/.test(value)
  ) fail('Invalid ' + field + ' in the authority state.');
  return value;
}

function asRole(value: unknown): ActorRole {
  if (value !== 'principal' && value !== 'worker' && value !== 'observer' && value !== 'system') {
    fail('Invalid actor role in the authority state.');
  }
  return value;
}

function asBooleanDomain(value: unknown, field: string): 0 | 1 {
  if (value !== 0 && value !== 1) fail('Invalid ' + field + ' in the authority state.');
  return value;
}

function assertTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('Invalid ' + field + ' in the authority state.');
  }
  return value;
}

function validateActorRows(db: SqliteDatabase): Map<string, ActorSqlRow> {
  const rows = db.prepare(
    'SELECT actor_id, role, capabilities_json, disabled, created_at FROM actors ORDER BY actor_id',
  ).all() as ActorSqlRow[];
  const actors = new Map<string, ActorSqlRow>();
  for (const row of rows) {
    const actorId = asText(row.actor_id, 'actor_id');
    if (actors.has(actorId)) fail('Duplicate actor identity in the authority state.');
    const role = asRole(row.role);
    const disabled = asBooleanDomain(row.disabled, 'actor disabled state');
    assertTimestamp(row.created_at, 'actor creation timestamp');
    const rawCapabilities = asText(row.capabilities_json, 'capabilities_json');
    const capabilities = parseCapabilities(rawCapabilities);
    assertRoleCapabilities(role, capabilities);
    if (canonicalCapabilitiesJson(capabilities) !== rawCapabilities) {
      fail('Actor capabilities are not in canonical order.');
    }
    actors.set(actorId, { ...row, role, disabled, capabilities_json: rawCapabilities });
  }

  const principals = [...actors.values()].filter((row) => row.role === 'principal');
  if (principals.length !== 1 || principals[0]?.actor_id !== 'codex' || principals[0]?.disabled !== 0) {
    fail('The authority state must contain exactly one enabled codex principal.');
  }

  const systemActors = [...actors.values()].filter((row) => row.role === 'system');
  if (
    systemActors.length !== 1
    || systemActors[0]?.actor_id !== 'system'
    || systemActors[0]?.disabled !== 0
    || systemActors[0]?.capabilities_json !== '[]'
  ) {
    fail('The authority state must contain exactly one enabled system actor with no public capabilities.');
  }
  const systemIdentity = actors.get('system');
  if (systemIdentity?.role !== 'system') {
    fail('The system actor identity is malformed.');
  }
  return actors;
}

function validateTokenRows(
  db: SqliteDatabase,
  actors: ReadonlyMap<string, ActorSqlRow>,
  nowMs: number,
  requireUsableToken: boolean,
): number {
  const rows = db.prepare(
    'SELECT token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at FROM actor_tokens ORDER BY token_id',
  ).all() as TokenSqlRow[];
  const digests = new Set<string>();
  let usable = 0;
  for (const row of rows) {
    asText(row.token_id, 'token_id');
    const actorId = asText(row.actor_id, 'token actor_id');
    const actor = actors.get(actorId);
    if (actor === undefined) fail('A token references a missing actor.');
    if (actor.role === 'system' || actorId === 'system') fail('The system actor cannot have a transport token.');
    const digest = asText(row.token_sha256, 'token digest').toLowerCase();
    if (!TOKEN_DIGEST.test(digest)) fail('A token digest has an invalid shape.');
    if (digests.has(digest)) fail('The authority state contains duplicate token digests.');
    digests.add(digest);
    asText(row.label, 'token label');
    assertTimestamp(row.created_at, 'token creation timestamp');
    const disabled = asBooleanDomain(row.disabled, 'token disabled state');
    let expired = false;
    if (row.expires_at !== null) {
      const expiry = assertTimestamp(row.expires_at, 'token expiry');
      expired = Date.parse(expiry) <= nowMs;
    }
    if (row.last_used_at !== null) assertTimestamp(row.last_used_at, 'token last-used timestamp');
    if (disabled === 0 && !expired) usable += 1;
  }
  if (requireUsableToken && usable === 0) {
    fail('The authority state has no usable transport token.');
  }
  return usable;
}

export function validatePhase4State(
  db: SqliteDatabase,
  nowMs = Date.now(),
  options: Phase4StateValidationOptions = {},
): Phase4StateReport {
  const actors = validateActorRows(db);
  return {
    principalActorId: 'codex',
    usableTokenCount: validateTokenRows(
      db,
      actors,
      nowMs,
      options.requireUsableToken ?? true,
    ),
  };
}
