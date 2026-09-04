import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import {
  createDirectAuthorizationContext,
  type AuthorizationContext,
} from '../../src/authority/context.js';
import {
  evaluateEdgeAdmission as evaluateEdgeAdmissionPolicy,
  type EdgeAdmissionFacts,
} from '../../src/authority/policy.js';
import { evaluateEdgeAdmission, type Phase4ManagementRuntime } from '../../src/authority/runtime.js';
import { validatePhase4State } from '../../src/authority/state.js';
import { runActorCommand, type ActorCommandOptions } from '../../src/commands/actors.js';
import { runTokenCommand } from '../../src/commands/tokens.js';
import { hashAccessToken, actorAuthInfoFromSdk, createSdkTokenVerifier } from '../../src/mcp/auth.js';
import { createPersistentTokenResolver } from '../../src/mcp/persistentAuth.js';
import { createMcpServerFactory } from '../../src/mcp/server.js';
import { closeHttpServer, listenHttpServer, MCP_HTTP_HOST } from '../../src/mcp/http.js';
import type { Phase5JobToolOptions } from '../../src/mcp/tools/jobLifecycle.js';
import type { Phase7EvidenceArtifactToolOptions } from '../../src/mcp/tools/phase7.js';
import { verifyDatabaseIntegrity } from '../../src/store/integrity.js';
import {
  closeStoreFixture,
  createStoreFixture,
  type StoreFixture,
} from './testHelpers.js';

let fixture: StoreFixture;
let audit: AuditWriter;

const NOW = Date.parse('2026-09-04T00:00:00Z');

function insertIntegration(
  integrationId = 'integration-fixture',
  generation = 0,
  enabled = 1,
): void {
  fixture.db.prepare(
    'INSERT INTO integrations(integration_id, generation, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    integrationId,
    generation,
    enabled,
    '2026-09-04T00:00:00Z',
    '2026-09-04T00:00:00Z',
  );
}

function insertEdgeActor(actorId = 'edge-fixture', disabled = 0): void {
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    actorId,
    'edge',
    'Synthetic Edge',
    '["delegation:request"]',
    disabled,
    '2026-09-04T00:00:00Z',
  );
}

function insertEdgeToken(
  tokenId = 'edge-token-fixture',
  actorId = 'edge-fixture',
  token = 'edge-secret-fixture',
): void {
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    tokenId,
    actorId,
    hashAccessToken(token),
    'synthetic-edge-token',
    0,
    null,
    null,
    '2026-09-04T00:00:00Z',
  );
}

function insertEdgeBinding(
  actorId = 'edge-fixture',
  integrationId = 'integration-fixture',
  enabled = 1,
): void {
  fixture.db.prepare(
    'INSERT INTO edge_transport_bindings(edge_actor_id, integration_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(actorId, integrationId, enabled, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
}

function edgeContext(): AuthorizationContext {
  const authInfo = fixture.db.prepare(
    'SELECT actor_id, role, capabilities_json FROM actors WHERE actor_id = ?',
  ).get('edge-fixture') as {
    readonly actor_id: string;
    readonly role: 'edge';
    readonly capabilities_json: string;
  };
  const context = createDirectAuthorizationContext({
    clientId: authInfo.actor_id,
    scopes: ['mcp'],
    tokenId: 'edge-token-fixture',
    sessionLabel: 'synthetic-edge-session',
    expiresAt: 2_000,
    actorId: authInfo.actor_id,
    role: authInfo.role,
    capabilities: JSON.parse(authInfo.capabilities_json) as ['delegation:request'],
    integrationId: 'integration-fixture',
    integrationGeneration: 0,
  });
  if (context === undefined) throw new Error('edge context was not created');
  return context;
}

function testRuntime(): Phase4ManagementRuntime {
  return {
    db: fixture.db,
    audit,
    state: { principalActorId: 'codex', usableTokenCount: 1 },
    authorizationState: undefined as never,
    authorizationReadiness: {
      readiness: 'READY',
      epochFingerprint: null,
      clockHighWaterMs: NOW,
      effectiveNowMs: NOW,
      detail: 'synthetic fixture',
    },
    close: () => undefined,
  };
}

function facts(overrides: Partial<EdgeAdmissionFacts> = {}): EdgeAdmissionFacts {
  return {
    readiness: 'READY',
    bindingExists: true,
    bindingEnabled: true,
    boundIntegrationId: 'integration-fixture',
    integrationExists: true,
    integrationEnabled: true,
    currentIntegrationId: 'integration-fixture',
    currentIntegrationGeneration: 0,
    ...overrides,
  };
}

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
  return JSON.parse(dataLine === undefined ? body : dataLine.slice('data: '.length)) as Record<string, unknown>;
}

function toolNames(payload: Record<string, unknown>): string[] {
  const result = payload.result as { readonly tools?: Array<{ readonly name: string }> } | undefined;
  return result?.tools?.map((tool) => tool.name) ?? [];
}

beforeEach(() => {
  fixture = createStoreFixture();
  audit = new AuditWriter(fixture.db, () => NOW);
  bootstrapProduction(fixture.db, audit, () => NOW);
  insertIntegration();
  insertEdgeActor();
  insertEdgeToken();
  insertEdgeBinding();
  fixture.security.harden(fixture.layout.databaseWal, 'file');
  fixture.security.harden(fixture.layout.databaseShm, 'file');
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('Phase 10B.4 schema and edge admission', () => {
  it('SCH-01/SCH-02/SCH-03/SCH-04/SCH-05/SCH-06/SCH-07 verifies schema 9 and canonical integrity', () => {
    const integrity = verifyDatabaseIntegrity(fixture.db);
    expect(integrity.schemaVersion).toBe(9);
    expect(integrity.tableCount).toBe(15);
    expect(integrity.triggerCount).toBe(37);
    expect(integrity.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(validatePhase4State(fixture.db, NOW, { requireUsableToken: false })).toMatchObject({
      principalActorId: 'codex',
    });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM edge_transport_bindings').get()).toEqual({ count: 1 });
    expect(fixture.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'delegations'").get()).toBeUndefined();
    expect(fixture.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%quota%'").get()).toBeUndefined();
  });

  it('AUTH-01/AUTH-02/AUTH-03 resolves only a bound edge identity and preserves generation as metadata', async () => {
    const resolver = createSdkTokenVerifier({
      verifyAccessToken: (token: string) => createPersistentTokenResolver(fixture.db, { audit }).verifyAccessToken(token),
    });
    const sdkAuth = await resolver.verifyAccessToken('edge-secret-fixture');
    const adapted = actorAuthInfoFromSdk(sdkAuth);
    expect(adapted).toMatchObject({
      actorId: 'edge-fixture',
      role: 'edge',
      capabilities: ['delegation:request'],
      integrationId: 'integration-fixture',
      integrationGeneration: 0,
    });
    const context = createDirectAuthorizationContext(adapted);
    if (context === undefined) throw new Error('edge context was not created');
    expect(context).toMatchObject({
      transportRole: 'edge',
      effectivePrincipalId: null,
      effectiveCapabilities: ['delegation:request'],
      integrationId: 'integration-fixture',
      integrationGeneration: 0,
    });
    expect(JSON.stringify(context)).not.toContain('edge-secret-fixture');
  });

  it('AUTH-HTTP verifies the edge SDK adapter path without exposing any MCP tool', async () => {
    const resolver = createPersistentTokenResolver(fixture.db, { audit });
    const server = await listenHttpServer({
      resolver,
      version: '10b4-http-test',
      port: 0,
      verifyStartup: () => undefined,
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('HTTP server did not bind');
      const endpoint = `http://${MCP_HTTP_HOST}:${address.port}/mcp`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer edge-secret-fixture',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(200);
      expect(toolNames(await responsePayload(response))).toEqual([]);
    } finally {
      await closeHttpServer(server);
    }
  });

  it('AUTH-04/AUTH-05/AUTH-06 denies invalid edge capabilities and cross-role confusion', () => {
    const base = {
      clientId: 'edge-fixture',
      scopes: ['mcp'],
      tokenId: 'edge-token-fixture',
      sessionLabel: 'synthetic-edge-session',
      expiresAt: 2_000,
      actorId: 'edge-fixture',
      role: 'edge' as const,
      integrationId: 'integration-fixture',
      integrationGeneration: 0,
    };
    expect(createDirectAuthorizationContext({ ...base, capabilities: ['job:read'] })).toBeUndefined();
    expect(createDirectAuthorizationContext({ ...base, capabilities: ['job:decide'] })).toBeUndefined();
    expect(createDirectAuthorizationContext({ ...base, capabilities: ['delegation:request', 'job:read'] })).toBeUndefined();
    expect(createDirectAuthorizationContext({
      ...base,
      clientId: 'observer',
      actorId: 'observer',
      role: 'observer',
      capabilities: ['delegation:request'],
    })).toBeUndefined();
    expect(createDirectAuthorizationContext({
      ...base,
      clientId: 'codex',
      actorId: 'codex',
      role: 'principal',
      capabilities: ['delegation:request'],
    })).toBeUndefined();
  });

  it('ADM-01..06 requires READY, reads current generation, and always denies issuance', () => {
    const context = edgeContext();
    const runtime = testRuntime();
    try {
      expect(runtime.authorizationReadiness.readiness).toBe('READY');
      expect(evaluateEdgeAdmission(runtime, context, 'edge-admission-ready')).toEqual({
        allowed: false,
        reason: 'issuance_not_enabled',
      });
      fixture.db.prepare('UPDATE integrations SET generation = ?, updated_at = ? WHERE integration_id = ?')
        .run(1, '2026-09-04T00:00:01Z', 'integration-fixture');
      expect(evaluateEdgeAdmission(runtime, context, 'edge-admission-stale')).toEqual({
        allowed: false,
        reason: 'generation_mismatch',
      });
      expect(fixture.db.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({ count: 0 });
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    } finally {
      runtime.close();
    }
  });

  it('ADM-04 fails closed for every non-ready authorization state', () => {
    const context = edgeContext();
    for (const readiness of ['UNINITIALIZED', 'INVALID', 'CLOCK_ROLLBACK'] as const) {
      expect(evaluateEdgeAdmissionPolicy(context, facts({ readiness }))).toEqual({
        allowed: false,
        reason: 'authorization_state_unready',
      });
    }
    expect(evaluateEdgeAdmissionPolicy(context, facts({ currentIntegrationId: 'other-integration' }))).toEqual({
      allowed: false,
      reason: 'generation_mismatch',
    });
  });

  it('SEC-03 records fixed admission-denial audit metadata and denies on audit failure path', () => {
    const context = edgeContext();
    const runtime = testRuntime();
    try {
      const first = evaluateEdgeAdmission(runtime, context, 'edge-audit-1');
      expect(first).toEqual({ allowed: false, reason: 'issuance_not_enabled' });
      const row = fixture.db.prepare(
        'SELECT actor_id, actor_role, capability, action, result, detail_json FROM audit_log WHERE request_id = ?',
      ).get('edge-audit-1') as Record<string, unknown>;
      expect(row).toEqual({
        actor_id: 'edge-fixture',
        actor_role: 'edge',
        capability: 'delegation:request',
        action: 'edge.admission_denied',
        result: 'denied',
        detail_json: '{"reason":"issuance_not_enabled"}',
      });
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    } finally {
      runtime.close();
    }
  });

  it('SEC-06 characterizes repeated synthetic denial audit growth without claiming it is bounded', () => {
    const context = edgeContext();
    const runtime = testRuntime();
    try {
      const before = (fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get() as { count: number }).count;
      for (let index = 0; index < 5; index += 1) {
        expect(evaluateEdgeAdmission(runtime, context, `edge-sec-06-${index}`).allowed).toBe(false);
      }
      const after = (fixture.db.prepare('SELECT count(*) AS count FROM audit_log').get() as { count: number }).count;
      expect(after - before).toBe(5);
      expect(fixture.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'delegations'").get()).toBeUndefined();
      expect(fixture.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%quota%'").get()).toBeUndefined();
      expect(fixture.db.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({ count: 0 });
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    } finally {
      runtime.close();
    }
  });

  it('PROV-01/PROV-02 rejects edge actor and token provisioning without changing commands', () => {
    expect(() => runActorCommand(fixture.context, {
      action: 'create',
      actorId: 'edge-cli-attempt',
      role: 'edge',
    } as unknown as ActorCommandOptions)).toThrow('observer role');
    expect(() => runTokenCommand(fixture.context, {
      action: 'issue',
      label: 'edge-token-attempt',
      actorId: 'edge-fixture',
    })).toThrow('codex or observer');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM actor_tokens WHERE actor_id = ?').get('edge-fixture')).toEqual({ count: 1 });
  });

  it('PROV-03 fresh schema 9 seeds no edge or integration rows', () => {
    const fresh = createStoreFixture();
    try {
      expect(verifyDatabaseIntegrity(fresh.db).schemaVersion).toBe(9);
      expect(fresh.db.prepare('SELECT count(*) AS count FROM actors WHERE role = ?').get('edge')).toEqual({ count: 0 });
      expect(fresh.db.prepare('SELECT count(*) AS count FROM actor_tokens').get()).toEqual({ count: 0 });
      expect(fresh.db.prepare('SELECT count(*) AS count FROM integrations').get()).toEqual({ count: 0 });
      expect(fresh.db.prepare('SELECT count(*) AS count FROM edge_transport_bindings').get()).toEqual({ count: 0 });
    } finally {
      closeStoreFixture(fresh);
    }
  });

  it('binding triggers reject rebinding, deletion, non-edge actors, and duplicate integrations', () => {
    expect(() => fixture.db.prepare(
      'INSERT INTO edge_transport_bindings(edge_actor_id, integration_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('codex', 'integration-fixture', 1, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')).toThrow('requires an edge actor');
    expect(() => fixture.db.prepare(
      'INSERT INTO edge_transport_bindings(edge_actor_id, integration_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('edge-missing', 'missing-integration', 1, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')).toThrow();
    expect(() => fixture.db.prepare(
      'UPDATE edge_transport_bindings SET integration_id = ? WHERE edge_actor_id = ?',
    ).run('other-integration', 'edge-fixture')).toThrow('identity and creation time are immutable');
    expect(() => fixture.db.prepare(
      'DELETE FROM edge_transport_bindings WHERE edge_actor_id = ?',
    ).run('edge-fixture')).toThrow('cannot be deleted');

    insertIntegration('integration-second');
    insertEdgeActor('edge-second');
    expect(() => insertEdgeBinding('edge-second', 'integration-fixture')).toThrow();
    insertEdgeBinding('edge-second', 'integration-second');
    expect(verifyDatabaseIntegrity(fixture.db)).toMatchObject({ schemaVersion: 9 });
  });
});

describe('Phase 10B.4 M-1 and transport parity', () => {
  const observerAuth = {
    clientId: 'chatgpt_edge_reader',
    scopes: ['mcp'],
    tokenId: 'observer-token',
    sessionLabel: 'observer-session',
    expiresAt: 2_000,
    actorId: 'chatgpt_edge_reader',
    role: 'observer' as const,
    capabilities: ['job:read' as const],
  };

  it('M1-01/M1-02/M1-03 hides and directly denies evidence/artifact lists for observer and non-principal contexts', async () => {
    const options = {
      transport: 'http' as const,
      version: '10b4-test',
      staticAuthInfo: observerAuth,
      jobs: {} as Phase5JobToolOptions,
      artifacts: {} as Phase7EvidenceArtifactToolOptions,
    };
    const handler = createMcpHandler(
      createMcpServerFactory(options),
      { legacy: 'stateless', responseMode: 'json' },
    );
    try {
      const list = await responsePayload(await handler.fetch(request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })));
      expect(toolNames(list)).toEqual(['ping', 'job_get', 'job_list']);
      const direct = await responsePayload(await handler.fetch(request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'evidence_list', arguments: { job_id: 'job-1' } },
      })));
      expect(direct.error).toBeDefined();
    } finally {
      await handler.close();
    }
  });

  it('M1-04/M1-05 gives equivalent HTTP/stdio edge visibility and direct denial with no public edge route', async () => {
    const edgeAuth = {
      clientId: 'edge-fixture',
      scopes: ['mcp'],
      tokenId: 'edge-token-fixture',
      sessionLabel: 'edge-session',
      expiresAt: 2_000,
      actorId: 'edge-fixture',
      role: 'edge' as const,
      capabilities: ['delegation:request' as const],
      integrationId: 'integration-fixture',
      integrationGeneration: 0,
    };
    const httpHandler = createMcpHandler(
      createMcpServerFactory({ transport: 'http', version: '10b4-test', staticAuthInfo: edgeAuth }),
      { legacy: 'stateless', responseMode: 'json' },
    );
    const stdioHandler = createMcpHandler(
      createMcpServerFactory({ transport: 'stdio', version: '10b4-test', staticAuthInfo: edgeAuth }),
      { legacy: 'stateless', responseMode: 'json' },
    );
    try {
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      const httpList = await responsePayload(await httpHandler.fetch(request(body)));
      const stdioList = await responsePayload(await stdioHandler.fetch(request(body)));
      expect(toolNames(httpList)).toEqual([]);
      expect(toolNames(stdioList)).toEqual(toolNames(httpList));

      const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codex_decide', arguments: {} } };
      const httpCall = await responsePayload(await httpHandler.fetch(request(call)));
      const stdioCall = await responsePayload(await stdioHandler.fetch(request(call)));
      expect(httpCall.error).toBeDefined();
      expect(stdioCall.error).toBeDefined();
    } finally {
      await httpHandler.close();
      await stdioHandler.close();
    }
  });
});
