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
  if (
    value !== 'principal'
    && value !== 'worker'
    && value !== 'observer'
    && value !== 'system'
    && value !== 'edge'
  ) {
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

interface EdgeBindingSqlRow {
  readonly edge_actor_id: unknown;
  readonly integration_id: unknown;
  readonly enabled: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ?',
  ).get('table', table) as { readonly present?: unknown } | undefined;
  return row?.present === 1;
}

function validateEdgeBindings(
  db: SqliteDatabase,
  actors: ReadonlyMap<string, ActorSqlRow>,
): void {
  const edgeActorIds = [...actors.entries()]
    .filter(([, actor]) => actor.role === 'edge')
    .map(([actorId]) => actorId);
  if (!tableExists(db, 'edge_transport_bindings')) {
    if (edgeActorIds.length !== 0) fail('The authority state has an edge actor without binding storage.');
    return;
  }

  const rows = db.prepare(
    'SELECT edge_actor_id, integration_id, enabled, created_at, updated_at FROM edge_transport_bindings ORDER BY edge_actor_id',
  ).all() as EdgeBindingSqlRow[];
  const boundActors = new Set<string>();
  for (const row of rows) {
    const actorId = asText(row.edge_actor_id, 'edge actor_id');
    const integrationId = asText(row.integration_id, 'edge integration_id');
    if (boundActors.has(actorId)) fail('The authority state contains duplicate edge bindings.');
    boundActors.add(actorId);
    if (row.enabled !== 0 && row.enabled !== 1) fail('Invalid edge binding enabled state.');
    assertTimestamp(row.created_at, 'edge binding creation timestamp');
    assertTimestamp(row.updated_at, 'edge binding update timestamp');
    if (actors.get(actorId)?.role !== 'edge') {
      fail('An edge binding references a non-edge actor.');
    }
    const integration = db.prepare(
      'SELECT integration_id FROM integrations WHERE integration_id = ?',
    ).get(integrationId) as { readonly integration_id?: unknown } | undefined;
    if (integration?.integration_id !== integrationId) {
      fail('An edge binding references a missing integration.');
    }
  }

  if (boundActors.size !== edgeActorIds.length || edgeActorIds.some((actorId) => !boundActors.has(actorId))) {
    fail('Every edge actor must have exactly one edge transport binding.');
  }
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
  validateEdgeBindings(db, actors);
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
