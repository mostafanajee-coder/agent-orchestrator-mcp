import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { applyDecision, DecisionError } from '../../src/authority/decision.js';
import { validatePhase4State } from '../../src/authority/state.js';
import { openPhase4ManagementRuntime, openPhase4Runtime } from '../../src/authority/runtime.js';
import { runTokenCommand } from '../../src/commands/tokens.js';
import {
  createPersistentTokenResolver,
} from '../../src/mcp/persistentAuth.js';
import {
  createMcpServerFactory,
} from '../../src/mcp/server.js';
import {
  createSdkTokenVerifier,
  hashAccessToken,
} from '../../src/mcp/auth.js';
import {
  closeStoreFixture,
  createStoreFixture,
  seedJob,
  seedRun,
  type StoreFixture,
} from './testHelpers.js';

let fixture: StoreFixture;

beforeEach(() => {
  fixture = createStoreFixture();
});

afterEach(() => {
  closeStoreFixture(fixture);
});

function request(body: unknown): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  if (dataLine === undefined) throw new Error(`MCP response did not contain data: ${body}`);
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

describe('Phase 4 bootstrap and persistent authority', () => {
  it('bootstraps exactly one principal, one system actor, and a digest-only token', () => {
    const audit = new AuditWriter(fixture.db);
    const first = bootstrapProduction(fixture.db, audit, () => Date.parse('2026-08-31T00:00:00Z'));

    expect(first.bootstrapped).toBe(true);
    expect(first.initialToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = fixture.db.prepare(
      'SELECT actor_id, token_sha256, label FROM actor_tokens',
    ).get() as { readonly actor_id: string; readonly token_sha256: string; readonly label: string };
    expect(stored.actor_id).toBe('codex');
    expect(stored.token_sha256).toBe(hashAccessToken(first.initialToken as string));
    expect(stored.token_sha256).not.toBe(first.initialToken);
    expect(stored.label).toBe('codex-initial');
    expect(validatePhase4State(fixture.db, Date.parse('2026-08-31T00:00:00Z'))).toEqual({
      principalActorId: 'codex',
      usableTokenCount: 1,
    });
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });

    expect(bootstrapProduction(fixture.db, audit, () => Date.parse('2026-08-31T00:00:00Z'))).toEqual({
      bootstrapped: false,
    });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM actors').get()).toEqual({ count: 2 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM actor_tokens').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get()).toEqual({ count: 1 });
  });

  it('rejects a partial authority state without auto-repair', () => {
    fixture.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('codex', 'principal', 'Codex', '["job:decide"]', 0, '2026-08-31T00:00:00Z');

    expect(() => bootstrapProduction(fixture.db, new AuditWriter(fixture.db))).toThrow(
      'partial',
    );
    expect(fixture.db.prepare('SELECT count(*) AS count FROM actors').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get()).toEqual({ count: 0 });
  });

  it('resolves the database token to trusted actor/session data and never falls back', () => {
    const audit = new AuditWriter(fixture.db);
    const bootstrapped = bootstrapProduction(fixture.db, audit).initialToken;
    if (bootstrapped === undefined) throw new Error('bootstrap did not return the test token');
    const resolver = createPersistentTokenResolver(fixture.db, { audit });

    const auth = resolver.verifyAccessTokenSync(bootstrapped);
    expect(auth).toMatchObject({
      clientId: 'codex',
      actorId: 'codex',
      role: 'principal',
      scopes: ['mcp'],
      capabilities: expect.arrayContaining(['job:decide']),
      tokenId: 'token-initial',
      sessionLabel: 'codex-initial',
    });
    expect(JSON.stringify(auth)).not.toContain(bootstrapped);
    expect(() => resolver.verifyAccessTokenSync('wrong-token')).toThrow('Invalid access token');
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log WHERE action = ?').get('auth.rejected')).toEqual({ count: 1 });
  });

  it('rejects disabled and expired rows while retaining them for history', () => {
    const audit = new AuditWriter(fixture.db);
    const initial = bootstrapProduction(fixture.db, audit).initialToken;
    if (initial === undefined) throw new Error('bootstrap did not return the test token');
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('disabled-token', 'codex', hashAccessToken('disabled-token'), 'disabled', 1, null, null, '2026-08-31T00:00:00Z');
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('expired-token', 'codex', hashAccessToken('expired-token'), 'expired', 0, '2026-08-30T00:00:00Z', null, '2026-08-30T00:00:00Z');
    const resolver = createPersistentTokenResolver(fixture.db, {
      audit,
      clock: () => Date.parse('2026-08-31T00:00:00Z'),
    });
    expect(() => resolver.verifyAccessTokenSync('disabled-token')).toThrow('Invalid access token');
    expect(() => resolver.verifyAccessTokenSync('expired-token')).toThrow('Invalid access token');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM actor_tokens').get()).toEqual({ count: 3 });
  });

  it('redacts configured and credential-shaped values and rejects non-positive audit sequences', () => {
    const secret = 'raw-secret-value';
    const audit = new AuditWriter(
      fixture.db,
      () => Date.parse('2026-08-31T00:00:00Z'),
      100,
      { secretValues: [secret] },
    );
    const row = audit.append({
      actorId: 'system',
      actorRole: 'system',
      requestId: 'audit-redaction',
      sessionHint: secret,
      action: 'auth.rejected',
      result: 'denied',
      detail: {
        authorization: `Bearer ${secret}`,
        digest: secret,
        nested: `value=${secret}`,
      },
      timestamp: '2026-08-31T00:00:00Z',
    });
    expect(row.sessionHint).toBe('[REDACTED]');
    expect(row.detailJson).not.toContain(secret);
    expect(row.detailJson).not.toContain('Bearer ' + secret);
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });

    fixture.db.prepare(
      "INSERT INTO audit_log(seq, ts, actor_id, actor_role, request_id, action, result, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(-1, '2026-08-31T00:00:01Z', 'system', 'system', 'bad-sequence', 'auth.rejected', 'denied', '0'.repeat(64), '1'.repeat(64));
    expect(verifyAuditChain(fixture.db)).toMatchObject({ valid: false, firstInvalidSeq: -1 });
  });

  it('rejects system-linked tokens and permits a valid authority state with no usable token only for administration', () => {
    const audit = new AuditWriter(fixture.db);
    bootstrapProduction(fixture.db, audit);
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('system-token', 'system', hashAccessToken('system-token'), 'internal', 0, null, null, '2026-08-31T00:00:00Z');
    expect(() => validatePhase4State(fixture.db)).toThrow('system actor cannot have a transport token');
    expect(() => createPersistentTokenResolver(fixture.db).verifyAccessTokenSync('system-token')).toThrow('Invalid access token');
  });
});

describe('Phase 4 local token lifecycle', () => {
  it('issues, lists, and revokes a second token without exposing its digest', () => {
    const initial = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
    if (initial === undefined) throw new Error('bootstrap did not return the test token');
    fixture.db.close();

    const issued = runTokenCommand(fixture.context, {
      action: 'issue',
      label: 'operator-session',
      expiresAt: '2030-01-01T00:00:00Z',
    }, () => Date.parse('2026-08-31T00:00:00Z'));
    expect(issued.action).toBe('issue');
    expect(issued.plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.plaintext).not.toBe(initial);

    const listed = runTokenCommand(fixture.context, { action: 'list' });
    expect(listed.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'codex-initial', disabled: false }),
      expect.objectContaining({ label: 'operator-session', disabled: false, expiresAt: '2030-01-01T00:00:00.000Z' }),
    ]));
    expect(JSON.stringify(listed)).not.toContain(hashAccessToken(issued.plaintext as string));

    const revoked = runTokenCommand(fixture.context, {
      action: 'revoke',
      tokenId: issued.tokenId as string,
    });
    expect(revoked).toEqual({ action: 'revoke', tokenId: issued.tokenId, revoked: true });
    const repeated = runTokenCommand(fixture.context, {
      action: 'revoke',
      tokenId: issued.tokenId as string,
    });
    expect(repeated).toEqual({ action: 'revoke', tokenId: issued.tokenId, revoked: false });
  });

  it('enforces one-way token revocation and immutable binding fields', () => {
    const initial = bootstrapProduction(fixture.db, new AuditWriter(fixture.db)).initialToken;
    if (initial === undefined) throw new Error('bootstrap did not return the test token');
    expect(() => fixture.db.prepare(
      "UPDATE actor_tokens SET label = 'changed' WHERE token_id = 'token-initial'",
    ).run()).toThrow('actor token identity, binding, label, expiry, and creation time are immutable');
    expect(() => fixture.db.prepare(
      "UPDATE actors SET role = 'worker' WHERE actor_id = 'codex'",
    ).run()).toThrow('actor identity, role, capabilities, and creation time are immutable');
    fixture.db.prepare("UPDATE actor_tokens SET disabled = 1 WHERE token_id = 'token-initial'").run();
    expect(() => fixture.db.prepare("UPDATE actor_tokens SET disabled = 0 WHERE token_id = 'token-initial'").run()).toThrow(
      'disabled actor tokens cannot be re-enabled',
    );
  });

  it('opens the serving runtime only for a fully valid state, while management can issue into a zero-token state', () => {
    bootstrapProduction(fixture.db, new AuditWriter(fixture.db));
    fixture.db.close();
    const runtime = openPhase4Runtime(fixture.context);
    expect(runtime.state.usableTokenCount).toBe(1);
    runtime.close();

    const actorsOnly = createStoreFixture();
    try {
      const insert = actorsOnly.db.prepare(
        'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      insert.run('codex', 'principal', 'Codex', '["job:decide"]', 0, '2026-08-31T00:00:00Z');
      insert.run('system', 'system', 'System', '[]', 0, '2026-08-31T00:00:00Z');
      actorsOnly.db.close();
      expect(() => openPhase4Runtime(actorsOnly.context)).toThrow('no usable transport token');
      const management = openPhase4ManagementRuntime(actorsOnly.context);
      expect(management.state.usableTokenCount).toBe(0);
      management.close();
      const issued = runTokenCommand(actorsOnly.context, {
        action: 'issue',
        label: 'recovery-token',
      });
      expect(issued.action).toBe('issue');
      expect(issued.plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      closeStoreFixture(actorsOnly);
    }
  });
});

describe('Phase 4 codex_decide tool', () => {
  it('registers only for the verified principal and applies an audited CAS decision', async () => {
    const insertActor = fixture.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertActor.run('codex', 'principal', 'Codex', '["job:decide"]', 0, '2026-08-31T00:00:00Z');
    insertActor.run('system', 'system', 'System', '[]', 0, '2026-08-31T00:00:00Z');
    insertActor.run('worker', 'worker', 'Worker', '["job:read"]', 0, '2026-08-31T00:00:00Z');
    const token = 'codex-decision-test-token';
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('decision-token', 'codex', hashAccessToken(token), 'decision-session', 0, null, null, '2026-08-31T00:00:00Z');
    const workerToken = 'worker-decision-test-token';
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('worker-token', 'worker', hashAccessToken(workerToken), 'worker-session', 0, null, null, '2026-08-31T00:00:00Z');
    seedJob(fixture.db);
    const audit = new AuditWriter(fixture.db);
    const resolver = createPersistentTokenResolver(fixture.db, { audit });
    const authInfo = await createSdkTokenVerifier(resolver).verifyAccessToken(token);
    const handler = createMcpHandler(
      createMcpServerFactory({
        transport: 'http',
        version: '0.0.0-test',
        authority: { db: fixture.db, audit },
      }),
      { legacy: 'stateless', responseMode: 'json' },
    );

    try {
      const toolsResponse = await handler.fetch(
        request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { authInfo },
      );
      const toolsPayload = await responsePayload(toolsResponse);
      const tools = (toolsPayload.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((tool) => tool.name)).toEqual(['ping', 'codex_decide']);

      const workerAuthInfo = await createSdkTokenVerifier(resolver).verifyAccessToken(workerToken);
      const workerToolsResponse = await handler.fetch(
        request({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
        { authInfo: workerAuthInfo },
      );
      const workerToolsPayload = await responsePayload(workerToolsResponse);
      expect((workerToolsPayload.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(['ping']);

      const idempotencyKey = '11111111-1111-4111-8111-111111111111';
      const response = await handler.fetch(
        request({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'codex_decide',
            arguments: {
              job_id: 'job-1',
              cycle: 0,
              decision: 'APPROVE',
              rationale: 'Evidence is complete and the approved gate is satisfied.',
              expected_version: 1,
              idempotency_key: idempotencyKey,
              session_hint: 'untrusted-client-hint',
            },
          },
        }),
        { authInfo },
      );
      const payload = await responsePayload(response);
      expect(payload.result).toMatchObject({ structuredContent: { ok: true, state: 'APPROVED', version: 2 } });

      const replay = await handler.fetch(
        request({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'codex_decide',
            arguments: {
              job_id: 'job-1',
              cycle: 0,
              decision: 'APPROVE',
              rationale: 'Evidence is complete and the approved gate is satisfied.',
              expected_version: 1,
              idempotency_key: idempotencyKey,
              session_hint: 'untrusted-client-hint',
            },
          },
        }),
        { authInfo },
      );
      const replayPayload = await responsePayload(replay);
      expect(replayPayload.result).toMatchObject({ structuredContent: { ok: true } });
      expect(fixture.db.prepare('SELECT count(*) AS count FROM decisions').get()).toEqual({ count: 1 });
      expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log WHERE action = ?').get('codex.decide')).toEqual({ count: 1 });
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    } finally {
      await handler.close();
    }
  });

  it('records IGNORE_FALSE_POSITIVE and then allows an audited approval over worker FAIL evidence', async () => {
    const insertActor = fixture.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertActor.run('codex', 'principal', 'Codex', '["job:decide"]', 0, '2026-08-31T00:00:00Z');
    insertActor.run('system', 'system', 'System', '[]', 0, '2026-08-31T00:00:00Z');
    insertActor.run('worker', 'worker', 'Worker', '["job:read","work:report"]', 0, '2026-08-31T00:00:00Z');
    const token = 'decision-domain-token';
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('domain-token', 'codex', hashAccessToken(token), 'domain-session', 0, null, null, '2026-08-31T00:00:00Z');
    seedJob(fixture.db);
    seedRun(fixture.db, 'run-fail', 'job-1', 0, 'FAIL');
    const audit = new AuditWriter(fixture.db);
    const auth = createPersistentTokenResolver(fixture.db).verifyAccessTokenSync(token);

    const ignored = applyDecision(fixture.db, audit, auth, {
      jobId: 'job-1',
      cycle: 0,
      decision: 'IGNORE_FALSE_POSITIVE',
      rationale: 'The worker failure is a false positive after principal review.',
      expectedVersion: 1,
      requestId: 'ignore-request',
    });
    expect(ignored).toMatchObject({ state: 'EVIDENCE_READY', version: 2 });
    const approved = applyDecision(fixture.db, audit, auth, {
      jobId: 'job-1',
      cycle: 0,
      decision: 'APPROVE',
      rationale: 'The reviewed evidence supports approval despite the worker claim.',
      expectedVersion: 2,
      requestId: 'approve-request',
    });
    expect(approved).toMatchObject({ state: 'APPROVED', authoritativeStatus: 'APPROVED', version: 3 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM decisions').get()).toEqual({ count: 2 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log WHERE action = ?').get('codex.decide')).toEqual({ count: 2 });
  });

  it('rejects stale versions and invalid transitions without durable mutation', () => {
    const insertActor = fixture.db.prepare(
      'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertActor.run('codex', 'principal', 'Codex', '["job:decide"]', 0, '2026-08-31T00:00:00Z');
    insertActor.run('system', 'system', 'System', '[]', 0, '2026-08-31T00:00:00Z');
    const token = 'stale-decision-token';
    fixture.db.prepare(
      'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('stale-token', 'codex', hashAccessToken(token), 'stale-session', 0, null, null, '2026-08-31T00:00:00Z');
    seedJob(fixture.db);
    const audit = new AuditWriter(fixture.db);
    const auth = createPersistentTokenResolver(fixture.db).verifyAccessTokenSync(token);

    expect(() => applyDecision(fixture.db, audit, auth, {
      jobId: 'job-1',
      cycle: 0,
      decision: 'APPROVE',
      rationale: 'stale request',
      expectedVersion: 99,
    })).toThrowError(new DecisionError('STATE_CONFLICT', 'The job version changed before the decision was applied.'));
    expect(() => applyDecision(fixture.db, audit, auth, {
      jobId: 'job-1',
      cycle: 0,
      decision: 'PACKAGE',
      rationale: 'not valid from evidence ready',
      expectedVersion: 1,
    })).toThrow('requested decision is not valid');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM decisions').get()).toEqual({ count: 0 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get()).toEqual({ count: 0 });
    expect(fixture.db.prepare('SELECT state, version FROM jobs WHERE job_id = ?').get('job-1')).toEqual({
      state: 'EVIDENCE_READY',
      version: 1,
    });
  });
});
