import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { SqliteDatabase } from '../store/db.js';
import { withImmediateTransaction } from '../store/db.js';

import { canonicalCapabilitiesJson } from './capabilities.js';
import type { Capability } from './capabilities.js';
import { verifyAuditChain } from './audit.js';
import type { AuditWriter } from './audit.js';
import { validatePhase4State } from './state.js';

const PRINCIPAL_CAPABILITIES: readonly Capability[] = [
  'artifact:register',
  'evidence:add',
  'job:create',
  'job:decide',
  'job:read',
  'qa:request',
];

export interface BootstrapResult {
  readonly bootstrapped: boolean;
  readonly initialToken?: string;
}

export class BootstrapError extends Error {
  public override readonly name = 'BootstrapError';
}

function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare('SELECT count(*) AS count FROM ' + table).get() as { readonly count?: unknown };
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new BootstrapError('The authority state count is invalid.');
  return count;
}

function assertEmptyProductionState(db: SqliteDatabase): void {
  for (const table of [
    'actors',
    'actor_tokens',
    'jobs',
    'decisions',
    'worker_runs',
    'evidence',
    'artifacts',
    'leases',
    'idempotency',
    'audit_log',
  ]) {
    if (countRows(db, table) !== 0) {
      throw new BootstrapError('The database is not an empty production bootstrap state.');
    }
  }
}

function createToken(): { readonly plaintext: string; readonly digest: string } {
  const plaintext = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(plaintext, 'utf8').digest('hex');
  return { plaintext, digest };
}

export function bootstrapProduction(
  db: SqliteDatabase,
  audit: AuditWriter,
  now = () => Date.now(),
): BootstrapResult {
  let result: BootstrapResult | undefined;
  withImmediateTransaction(db, () => {
    const chain = verifyAuditChain(db);
    if (!chain.valid) {
      throw new BootstrapError(
        'The existing audit chain is invalid and requires explicit recovery.',
      );
    }
    const actorCount = countRows(db, 'actors');
    const tokenCount = countRows(db, 'actor_tokens');
    if (actorCount === 0 && tokenCount === 0) {
      assertEmptyProductionState(db);
      const token = createToken();
      const createdAt = new Date(now()).toISOString();
      db.prepare(
        'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'codex',
        'principal',
        'Codex',
        canonicalCapabilitiesJson(PRINCIPAL_CAPABILITIES),
        0,
        createdAt,
      );
      db.prepare(
        'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('system', 'system', 'System', '[]', 0, createdAt);
      db.prepare(
        'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'token-initial',
        'codex',
        token.digest,
        'codex-initial',
        0,
        null,
        null,
        createdAt,
      );
      audit.appendInTransaction({
        actorId: 'system',
        actorRole: 'system',
        requestId: randomUUID(),
        action: 'bootstrap.completed',
        result: 'ok',
        detail: { actor_id: 'codex', token_id: 'token-initial' },
        timestamp: createdAt,
      });
      validatePhase4State(db, now());
      result = { bootstrapped: true, initialToken: token.plaintext };
      return;
    }

    if (actorCount === 0 || tokenCount === 0) {
      throw new BootstrapError('The authority state is partial and requires explicit recovery.');
    }
    validatePhase4State(db, now());
    result = { bootstrapped: false };
  });
  if (result === undefined) throw new BootstrapError('The bootstrap result was not produced.');
  return result;
}
