import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import {
  actorAuthInfoFromAuthorizationContext,
  createDirectAuthorizationContext,
  isTrustedAuthorizationContext,
  type AuthorizationContext,
} from '../../src/authority/context.js';
import {
  actorForRequirement,
  authorizationPolicy,
  evaluateAuthorization,
} from '../../src/authority/policy.js';
import type { ActorRole, Capability } from '../../src/authority/capabilities.js';
import type { ActorAuthInfo } from '../../src/mcp/auth.js';
import { createMcpServerFactory } from '../../src/mcp/server.js';
import type { Phase5JobToolOptions } from '../../src/mcp/tools/jobLifecycle.js';
import type { Phase7EvidenceArtifactToolOptions } from '../../src/mcp/tools/phase7.js';

const PRINCIPAL_CAPABILITIES = [
  'artifact:register',
  'evidence:add',
  'job:create',
  'job:decide',
  'job:read',
  'qa:request',
] as const;

function auth(overrides: Partial<ActorAuthInfo> = {}): ActorAuthInfo {
  return {
    clientId: 'codex',
    scopes: ['mcp'],
    tokenId: 'context-test-token',
    sessionLabel: 'context-test-session',
    expiresAt: 2_000,
    actorId: 'codex',
    role: 'principal',
    capabilities: PRINCIPAL_CAPABILITIES,
    ...overrides,
  };
}

function forgedContext(
  context: AuthorizationContext,
  overrides: Readonly<Record<string, unknown>>,
): AuthorizationContext {
  const clone = Object.create(Object.getPrototypeOf(context)) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(context)) {
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    if (descriptor !== undefined) Object.defineProperty(clone, key, descriptor);
  }
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(clone, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
  return Object.freeze(clone) as unknown as AuthorizationContext;
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

describe('Phase 10B.1 authorization context', () => {
  it('creates an immutable direct context with normalized provenance and no bearer', () => {
    const bearer = 'context-test-bearer-never-in-context';
    const context = createDirectAuthorizationContext(auth({ tokenId: 'token-id-only' }));
    if (context === undefined) throw new Error('context was not created');

    expect(isTrustedAuthorizationContext(context)).toBe(true);
    expect(context).toMatchObject({
      transportActorId: 'codex',
      transportRole: 'principal',
      effectivePrincipalId: 'codex',
      effectiveCapabilities: PRINCIPAL_CAPABILITIES,
      authMode: 'direct',
      authorizationSource: 'authenticated-actor',
      provenance: {
        transportActorId: 'codex',
        sessionTokenId: 'token-id-only',
        sessionLabel: 'context-test-session',
        authorizationSource: 'authenticated-actor',
      },
    });
    expect(JSON.stringify(context)).not.toContain(bearer);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.effectiveCapabilities)).toBe(true);
    expect(Object.isFrozen(context.provenance)).toBe(true);
    expect(() => (context.effectiveCapabilities as unknown as string[]).push('job:read')).toThrow();

    const actor = actorAuthInfoFromAuthorizationContext(context);
    expect(actor).toMatchObject({
      clientId: 'codex',
      actorId: 'codex',
      role: 'principal',
      capabilities: PRINCIPAL_CAPABILITIES,
      tokenId: 'token-id-only',
    });
  });

  const identityCases: ReadonlyArray<{
    readonly label: string;
    readonly authInfo: ActorAuthInfo;
    readonly capability: Capability;
    readonly allowedRoles: readonly ActorRole[];
    readonly requiredActorId?: string;
    readonly expectedAllowed: boolean;
  }> = [
    {
      label: 'codex principal',
      authInfo: auth(),
      capability: 'job:decide',
      allowedRoles: ['principal'],
      requiredActorId: 'codex',
      expectedAllowed: true,
    },
    {
      label: 'observer reader',
      authInfo: auth({
        clientId: 'chatgpt_edge_reader',
        actorId: 'chatgpt_edge_reader',
        tokenId: 'observer-token',
        role: 'observer',
        capabilities: ['job:read'],
      }),
      capability: 'job:read',
      allowedRoles: ['observer'],
      expectedAllowed: true,
    },
    {
      label: 'worker reporter',
      authInfo: auth({
        clientId: 'worker-1',
        actorId: 'worker-1',
        tokenId: 'worker-token',
        role: 'worker',
        capabilities: ['artifact:register', 'evidence:add', 'job:read', 'work:report'],
      }),
      capability: 'work:report',
      allowedRoles: ['worker'],
      expectedAllowed: true,
    },
    {
      label: 'system actor',
      authInfo: auth({
        clientId: 'system',
        actorId: 'system',
        tokenId: 'internal-system-context',
        role: 'system',
        capabilities: [],
      }),
      capability: 'job:read',
      allowedRoles: ['system'],
      expectedAllowed: false,
    },
  ];

  it.each(identityCases)('preserves the $label direct authorization boundary', (caseData) => {
    const context = createDirectAuthorizationContext(caseData.authInfo);
    if (context === undefined) throw new Error('context was not created');
    const decision = evaluateAuthorization(context, {
      capability: caseData.capability,
      allowedRoles: caseData.allowedRoles,
      ...(caseData.requiredActorId === undefined ? {} : { requiredActorId: caseData.requiredActorId }),
    });
    expect(decision.allowed).toBe(caseData.expectedAllowed);
    expect(authorizationPolicy.evaluate(context, {
      capability: caseData.capability,
      allowedRoles: caseData.allowedRoles,
      ...(caseData.requiredActorId === undefined ? {} : { requiredActorId: caseData.requiredActorId }),
    }).allowed).toBe(caseData.expectedAllowed);
  });

  it('rejects malformed identity, role, capability, and caller-controlled projections', () => {
    const missingActor = auth();
    delete (missingActor as { actorId?: string }).actorId;
    const cases: ActorAuthInfo[] = [
      auth({ clientId: 'observer', actorId: 'codex' }),
      missingActor,
      auth({ role: 'unknown' as unknown as ActorRole }),
      auth({ capabilities: ['job:read', 'job:decide'] }),
      auth({ capabilities: ['job:decide', 'job:create', 'job:read', 'qa:request', 'evidence:add', 'artifact:register'] }),
      auth({ capabilities: ['job:decide', 'evidence:add', 'artifact:register', 'job:create', 'job:read', 'qa:request'] }),
    ];
    for (const candidate of cases) {
      expect(createDirectAuthorizationContext(candidate)).toBeUndefined();
    }

    const validObserver = createDirectAuthorizationContext(auth({
      clientId: 'chatgpt_edge_reader',
      actorId: 'chatgpt_edge_reader',
      role: 'observer',
      capabilities: ['job:read'],
    }));
    if (validObserver === undefined) throw new Error('observer context was not created');
    const copied = Object.freeze({ ...validObserver }) as unknown as AuthorizationContext;
    expect(isTrustedAuthorizationContext(copied)).toBe(false);
    expect(actorForRequirement(copied, { capability: 'job:decide' })).toBeUndefined();
  });

  it('denies delegated, unknown, missing, and malformed contexts without principal fallback', () => {
    const direct = createDirectAuthorizationContext(auth());
    if (direct === undefined) throw new Error('context was not created');

    const delegated = forgedContext(direct, { authMode: 'delegated' });
    expect(evaluateAuthorization(delegated, {
      capability: 'job:decide',
      allowedRoles: ['principal'],
      requiredActorId: 'codex',
    })).toEqual({ allowed: false, reason: 'delegated_mode_disabled' });
    expect(actorForRequirement(delegated, { capability: 'job:decide' })).toBeUndefined();

    const unknownMode = forgedContext(direct, { authMode: 'future-mode' });
    expect(evaluateAuthorization(unknownMode, { capability: 'job:decide' })).toEqual({
      allowed: false,
      reason: 'invalid_context',
    });
    expect(evaluateAuthorization(undefined, { capability: 'job:decide' })).toEqual({
      allowed: false,
      reason: 'missing_context',
    });
    expect(actorForRequirement(undefined, { capability: 'job:decide' })).toBeUndefined();
  });

  it('keeps the same normalized observer policy and denies wired writes for HTTP and stdio', async () => {
    const observerAuth = auth({
      clientId: 'chatgpt_edge_reader',
      actorId: 'chatgpt_edge_reader',
      tokenId: 'observer-token',
      role: 'observer',
      capabilities: ['job:read'],
    });
    const jobs = {} as Phase5JobToolOptions;
    const artifacts = {} as Phase7EvidenceArtifactToolOptions;
    const httpHandler = createMcpHandler(
      createMcpServerFactory({
        transport: 'http',
        version: '10b1-test',
        staticAuthInfo: observerAuth,
        jobs,
        artifacts,
      }),
      { legacy: 'stateless', responseMode: 'json' },
    );
    const stdioHandler = createMcpHandler(
      createMcpServerFactory({
        transport: 'stdio',
        version: '10b1-test',
        staticAuthInfo: observerAuth,
        jobs,
        artifacts,
      }),
      { legacy: 'stateless', responseMode: 'json' },
    );

    try {
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      const httpPayload = await responsePayload(await httpHandler.fetch(request(body)));
      const stdioPayload = await responsePayload(await stdioHandler.fetch(request(body)));
      const httpTools = (httpPayload.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
      const stdioTools = (stdioPayload.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
      expect(httpTools).toEqual(['ping', 'job_get', 'job_list', 'evidence_list', 'artifact_list']);
      expect(httpTools).not.toEqual(expect.arrayContaining([
        'job_create',
        'job_start',
        'job_resume',
        'artifact_register',
      ]));
      expect(stdioTools).toEqual(httpTools);
    } finally {
      await httpHandler.close();
      await stdioHandler.close();
    }
  });
});
