import { OAuthError } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import {
  authenticateEnvironmentToken,
  AuthConfigurationError,
  createEnvironmentTokenResolver,
  createInMemoryTokenResolver,
  createSdkTokenVerifier,
  hashAccessToken,
} from '../../src/mcp/auth.js';
import type { ActorTokenRecord } from '../../src/mcp/auth.js';

const TOKEN = 'phase2-test-token';

function record(overrides: Partial<ActorTokenRecord> = {}): ActorTokenRecord {
  return {
    tokenId: 'token-1',
    actorId: 'codex',
    tokenSha256: hashAccessToken(TOKEN),
    scopes: ['mcp'],
    sessionLabel: 'test-session',
    expiresAt: 2_000,
    ...overrides,
  };
}

describe('Phase 2 token-resolution boundary', () => {
  it('resolves a valid digest to actor and session identity without returning plaintext', async () => {
    const resolver = createInMemoryTokenResolver([record()], () => 1_000);
    const result = await resolver.verifyAccessToken(TOKEN);

    expect(result).toEqual({
      clientId: 'codex',
      scopes: ['mcp'],
      tokenId: 'token-1',
      sessionLabel: 'test-session',
      expiresAt: 2_000,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('fails closed for an unknown token without reflecting it', async () => {
    const resolver = createInMemoryTokenResolver([record()], () => 1_000);
    const unknown = 'unknown-token-that-must-not-appear';

    await expect(resolver.verifyAccessToken(unknown)).rejects.toBeInstanceOf(OAuthError);
    await expect(resolver.verifyAccessToken(unknown)).rejects.toThrow('Invalid access token');
    try {
      await resolver.verifyAccessToken(unknown);
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthError);
      expect((error as Error).message).not.toContain(unknown);
    }
  });

  it.each([
    ['disabled', { disabled: true }],
    ['expired', { expiresAt: 1_000 }],
  ])('fails closed for a %s actor token', async (_label, overrides) => {
    const resolver = createInMemoryTokenResolver([record(overrides)], () => 1_000);
    await expect(resolver.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(OAuthError);
  });

  it('adapts to the official SDK verifier while keeping session fields in extra metadata', async () => {
    const verifier = createSdkTokenVerifier(
      createInMemoryTokenResolver([record()], () => 1_000),
    );
    const result = await verifier.verifyAccessToken(TOKEN);

    expect(result.clientId).toBe('codex');
    expect(result.scopes).toEqual(['mcp']);
    expect(result.expiresAt).toBe(2_000);
    expect(result.extra).toEqual({ tokenId: 'token-1', sessionLabel: 'test-session' });
    // The official SDK requires this in-memory field for its verifier contract;
    // it is never persisted, logged, returned by ping, or placed in an error.
    expect(result.token).toBe(TOKEN);
  });

  it('allows multiple session digests to resolve to the same actor', async () => {
    const secondToken = 'phase2-second-session-token';
    const resolver = createInMemoryTokenResolver(
      [
        record(),
        record({
          tokenId: 'token-2',
          tokenSha256: hashAccessToken(secondToken),
          sessionLabel: 'second-session',
        }),
      ],
      () => 1_000,
    );

    const first = await resolver.verifyAccessToken(TOKEN);
    const second = await resolver.verifyAccessToken(secondToken);
    expect(first.clientId).toBe('codex');
    expect(second.clientId).toBe('codex');
    expect(first.tokenId).not.toBe(second.tokenId);
    expect(first.sessionLabel).not.toBe(second.sessionLabel);
  });

  it('rejects conflicting duplicate token digests at resolver construction', () => {
    expect(() => createInMemoryTokenResolver([record(), record({ tokenId: 'duplicate' })])).toThrow(
      /duplicate token digests/,
    );
  });

  it('requires an environment token before creating a production resolver', () => {
    expect(() => createEnvironmentTokenResolver({})).toThrow(AuthConfigurationError);
    expect(() => authenticateEnvironmentToken({})).toThrow(AuthConfigurationError);
  });

  it('authenticates the environment token once into non-secret startup identity', () => {
    const result = authenticateEnvironmentToken(
      {
        ORCHESTRATOR_ACTOR_TOKEN: TOKEN,
        ORCHESTRATOR_ACTOR_ID: 'codex',
        ORCHESTRATOR_SESSION_LABEL: 'stdio-test',
        ORCHESTRATOR_TOKEN_ID: 'stdio-token',
      },
      () => 1_000,
    );

    expect(result).toMatchObject({
      clientId: 'codex',
      tokenId: 'stdio-token',
      sessionLabel: 'stdio-test',
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
