import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { validatePhase4State } from '../../src/authority/state.js';
import { runActorCommand } from '../../src/commands/actors.js';
import { runTokenCommand } from '../../src/commands/tokens.js';
import { hashAccessToken } from '../../src/mcp/auth.js';
import { createPersistentTokenResolver } from '../../src/mcp/persistentAuth.js';
import { UsageError } from '../../src/errors.js';

import {
  closeStoreFixture,
  createStoreFixture,
  type StoreFixture,
} from './testHelpers.js';

let fixture: StoreFixture;

beforeEach(() => {
  fixture = createStoreFixture();
  for (const sidecar of [fixture.layout.databaseWal, fixture.layout.databaseShm]) {
    fixture.security.harden(sidecar, 'file');
  }
  const audit = new AuditWriter(fixture.db);
  expect(bootstrapProduction(fixture.db, audit).bootstrapped).toBe(true);
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('local observer provisioning', () => {
  it('creates a read-only observer and issues a DB-backed observer token', () => {
    const actor = runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'chatgpt_edge_reader',
      role: 'observer',
    });
    expect(actor).toEqual({
      action: 'create',
      actorId: 'chatgpt_edge_reader',
      role: 'observer',
      capabilities: ['job:read'],
    });

    const token = runTokenCommand(fixture.context, {
      action: 'issue',
      actorId: 'chatgpt_edge_reader',
      label: 'chatgpt-edge-reader',
    });
    expect(token.actorId).toBe('chatgpt_edge_reader');
    expect(token.plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const storedActor = fixture.db.prepare(
      'SELECT actor_id, role, capabilities_json, disabled FROM actors WHERE actor_id = ?',
    ).get('chatgpt_edge_reader');
    expect(storedActor).toEqual({
      actor_id: 'chatgpt_edge_reader',
      role: 'observer',
      capabilities_json: '["job:read"]',
      disabled: 0,
    });

    const storedToken = fixture.db.prepare(
      'SELECT token_id, actor_id, token_sha256, label, disabled FROM actor_tokens WHERE token_id = ?',
    ).get(token.tokenId) as {
      readonly token_id: string;
      readonly actor_id: string;
      readonly token_sha256: string;
      readonly label: string;
      readonly disabled: number;
    };
    expect(storedToken.actor_id).toBe('chatgpt_edge_reader');
    expect(storedToken.label).toBe('chatgpt-edge-reader');
    expect(storedToken.disabled).toBe(0);
    expect(storedToken.token_sha256).toBe(hashAccessToken(token.plaintext as string));
    expect(storedToken.token_sha256).not.toBe(token.plaintext);

    const auth = createPersistentTokenResolver(fixture.db).verifyAccessTokenSync(token.plaintext as string);
    expect(auth).toMatchObject({
      clientId: 'chatgpt_edge_reader',
      actorId: 'chatgpt_edge_reader',
      role: 'observer',
      capabilities: ['job:read'],
      scopes: ['mcp'],
      tokenId: token.tokenId,
      sessionLabel: 'chatgpt-edge-reader',
    });
    expect(JSON.stringify(auth)).not.toContain(token.plaintext as string);

    expect(validatePhase4State(fixture.db)).toMatchObject({
      principalActorId: 'codex',
      usableTokenCount: 2,
    });
    const auditRows = fixture.db.prepare(
      'SELECT action, detail_json FROM audit_log ORDER BY seq',
    ).all() as Array<{ readonly action: string; readonly detail_json: string | null }>;
    expect(auditRows.map((row) => row.action)).toContain('actor.created');
    expect(auditRows.map((row) => row.action)).toContain('token.issued');
    expect(JSON.stringify(auditRows)).not.toContain(token.plaintext as string);
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
  });

  it('rejects duplicates, reserved identities, invalid roles, and unsupported capability input', () => {
    runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'chatgpt_edge_reader',
      role: 'observer',
    });
    expect(() => runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'chatgpt_edge_reader',
      role: 'observer',
    })).toThrow('already exists');
    expect(() => runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'codex',
      role: 'observer',
    })).toThrow(UsageError);
    expect(() => runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'system',
      role: 'observer',
    })).toThrow(UsageError);
    expect(() => runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'second-principal',
      role: 'principal',
    } as never)).toThrow('only the observer role');
    expect(() => runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'arbitrary-capability',
      role: 'observer',
      capabilities: ['job:decide'],
    } as never)).toThrow('caller-supplied capabilities');
    const row = fixture.db.prepare(
      'SELECT capabilities_json FROM actors WHERE actor_id = ?',
    ).get('arbitrary-capability') as { readonly capabilities_json: string };
    expect(row).toBeUndefined();
  });

  it('does not issue tokens for system, worker, missing, or non-observer actors', () => {
    runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'chatgpt_edge_reader',
      role: 'observer',
    });
    expect(() => runTokenCommand(fixture.context, {
      action: 'issue',
      actorId: 'system',
      label: 'system-token',
    })).toThrow('only codex or observer');
    expect(() => runTokenCommand(fixture.context, {
      action: 'issue',
      actorId: 'missing-actor',
      label: 'missing-token',
    })).toThrow('does not exist');
    expect(() => runTokenCommand(fixture.context, {
      action: 'issue',
      actorId: 'chatgpt_edge_reader',
      label: 'observer-token',
    })).not.toThrow();
    expect(fixture.db.prepare(
      'SELECT count(*) AS count FROM actor_tokens WHERE actor_id = ?',
    ).get('chatgpt_edge_reader')).toEqual({ count: 1 });
  });
});
