import type { SqliteDatabase } from './db.js';
import { withImmediateTransaction } from './db.js';

export interface ActorRow {
  readonly actorId: string;
  readonly role: 'principal' | 'worker' | 'observer' | 'system';
  readonly displayName: string;
  readonly capabilitiesJson: string;
  readonly disabled: 0 | 1;
  readonly createdAt: string;
}

export interface ActorTokenRow {
  readonly tokenId: string;
  readonly actorId: string;
  readonly tokenSha256: string;
  readonly label: string;
  readonly disabled: 0 | 1;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface DecisionGrantRow {
  readonly decision: string;
  readonly authoritative_status: string;
}

export interface AuthoritativeStatusRow {
  readonly authoritative_status: string;
  readonly rank: number;
  readonly terminal: 0 | 1;
}

export interface ActorRepository {
  readonly insert: (row: ActorRow) => void;
  readonly get: (actorId: string) => ActorRow | undefined;
  readonly list: () => ActorRow[];
}

export interface ActorTokenRepository {
  readonly insert: (row: ActorTokenRow) => void;
  readonly get: (tokenId: string) => ActorTokenRow | undefined;
  readonly listForActor: (actorId: string) => ActorTokenRow[];
}

export interface ReferenceRepository {
  readonly grants: () => DecisionGrantRow[];
  readonly statuses: () => AuthoritativeStatusRow[];
}

export interface StructuralRepositories {
  readonly actors: ActorRepository;
  readonly actorTokens: ActorTokenRepository;
  readonly references: ReferenceRepository;
  readonly withImmediateTransaction: <T>(callback: () => T) => T;
}

function actorFromSql(row: Record<string, unknown>): ActorRow {
  return {
    actorId: String(row['actor_id']),
    role: row['role'] as ActorRow['role'],
    displayName: String(row['display_name']),
    capabilitiesJson: String(row['capabilities_json']),
    disabled: Number(row['disabled']) as 0 | 1,
    createdAt: String(row['created_at']),
  };
}

function tokenFromSql(row: Record<string, unknown>): ActorTokenRow {
  return {
    tokenId: String(row['token_id']),
    actorId: String(row['actor_id']),
    tokenSha256: String(row['token_sha256']),
    label: String(row['label']),
    disabled: Number(row['disabled']) as 0 | 1,
    expiresAt: row['expires_at'] === null ? null : String(row['expires_at']),
    lastUsedAt: row['last_used_at'] === null ? null : String(row['last_used_at']),
    createdAt: String(row['created_at']),
  };
}

export function createStructuralRepositories(db: SqliteDatabase): StructuralRepositories {
  const actorInsert = db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const actorSelect = db.prepare(
    'SELECT actor_id, role, display_name, capabilities_json, disabled, created_at FROM actors WHERE actor_id = ?',
  );
  const actorList = db.prepare(
    'SELECT actor_id, role, display_name, capabilities_json, disabled, created_at FROM actors ORDER BY actor_id',
  );

  const tokenInsert = db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const tokenSelect = db.prepare(
    'SELECT token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at FROM actor_tokens WHERE token_id = ?',
  );
  const tokenList = db.prepare(
    'SELECT token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at FROM actor_tokens WHERE actor_id = ? ORDER BY token_id',
  );

  return {
    actors: {
      insert: (row) => {
        actorInsert.run(
          row.actorId,
          row.role,
          row.displayName,
          row.capabilitiesJson,
          row.disabled,
          row.createdAt,
        );
      },
      get: (actorId) => {
        const row = actorSelect.get(actorId) as Record<string, unknown> | undefined;
        return row === undefined ? undefined : actorFromSql(row);
      },
      list: () => actorList.all().map((row) => actorFromSql(row as Record<string, unknown>)),
    },
    actorTokens: {
      insert: (row) => {
        tokenInsert.run(
          row.tokenId,
          row.actorId,
          row.tokenSha256,
          row.label,
          row.disabled,
          row.expiresAt,
          row.lastUsedAt,
          row.createdAt,
        );
      },
      get: (tokenId) => {
        const row = tokenSelect.get(tokenId) as Record<string, unknown> | undefined;
        return row === undefined ? undefined : tokenFromSql(row);
      },
      listForActor: (actorId) => tokenList.all(actorId)
        .map((row) => tokenFromSql(row as Record<string, unknown>)),
    },
    references: {
      grants: () => db.prepare(
        'SELECT decision, authoritative_status FROM decision_grants ORDER BY decision, authoritative_status',
      ).all() as DecisionGrantRow[],
      statuses: () => db.prepare(
        'SELECT authoritative_status, rank, terminal FROM authoritative_statuses ORDER BY rank',
      ).all() as AuthoritativeStatusRow[],
    },
    withImmediateTransaction: (callback) => withImmediateTransaction(db, callback),
  };
}
