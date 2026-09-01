import { describe, expect, it } from 'vitest';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { applyTransition } from '../../src/domain/decide.js';
import { RequestRateLimiter } from '../../src/mcp/admission.js';
import { hashAccessToken } from '../../src/mcp/auth.js';
import { createPersistentTokenResolver } from '../../src/mcp/persistentAuth.js';
import { closeStoreFixture, createStoreFixture, seedJob } from './testHelpers.js';

describe('Phase 9 two-session authority drill', () => {
  it('keeps one principal identity with distinct verified attribution and buckets', () => {
    const fixture = createStoreFixture();
    try {
      const audit = new AuditWriter(fixture.db);
      const bootstrap = bootstrapProduction(fixture.db, audit);
      if (bootstrap.initialToken === undefined) throw new Error('bootstrap did not return a token');
      const tokenB = 'phase9-second-session-token';
      fixture.db.prepare(
        'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'token-session-b',
        'codex',
        hashAccessToken(tokenB),
        'session-b',
        0,
        null,
        null,
        '2026-09-01T00:00:00Z',
      );
      const resolver = createPersistentTokenResolver(fixture.db, { audit });
      const sessionA = resolver.verifyAccessTokenSync(bootstrap.initialToken);
      const sessionB = resolver.verifyAccessTokenSync(tokenB);

      expect(sessionA.actorId).toBe('codex');
      expect(sessionB.actorId).toBe('codex');
      expect(sessionA.tokenId).not.toBe(sessionB.tokenId);
      expect(sessionA.sessionLabel).toBe('codex-initial');
      expect(sessionB.sessionLabel).toBe('session-b');

      seedJob(fixture.db, 'job-session-a', 'EVIDENCE_READY');
      seedJob(fixture.db, 'job-session-b', 'EVIDENCE_READY');
      applyTransition(fixture.db, audit, sessionA, {
        jobId: 'job-session-a',
        cycle: 0,
        decision: 'APPROVE',
        rationale: 'session A decision',
        expectedVersion: 1,
        sessionHint: 'forged-a-decoration',
        requestId: 'session-a-request',
      });
      applyTransition(fixture.db, audit, sessionB, {
        jobId: 'job-session-b',
        cycle: 0,
        decision: 'APPROVE',
        rationale: 'session B decision',
        expectedVersion: 1,
        sessionHint: 'forged-b-decoration',
        requestId: 'session-b-request',
      });

      expect(fixture.db.prepare(
        'SELECT session_token_id, session_hint FROM decisions WHERE job_id = ?',
      ).get('job-session-a')).toEqual({
        session_token_id: 'token-initial',
        session_hint: 'forged-a-decoration',
      });
      expect(fixture.db.prepare(
        'SELECT session_token_id, session_hint FROM decisions WHERE job_id = ?',
      ).get('job-session-b')).toEqual({
        session_token_id: 'token-session-b',
        session_hint: 'forged-b-decoration',
      });
      expect(fixture.db.prepare(
        'SELECT session_token_id FROM audit_log WHERE action = ? AND job_id = ? ORDER BY seq DESC LIMIT 1',
      ).get('codex.decide', 'job-session-b')).toEqual({ session_token_id: 'token-session-b' });

      seedJob(fixture.db, 'job-session-race', 'EVIDENCE_READY');
      applyTransition(fixture.db, audit, sessionA, {
        jobId: 'job-session-race',
        cycle: 0,
        decision: 'IGNORE_FALSE_POSITIVE',
        rationale: 'first session owns this CAS slot',
        expectedVersion: 1,
      });
      expect(() => applyTransition(fixture.db, audit, sessionB, {
        jobId: 'job-session-race',
        cycle: 0,
        decision: 'APPROVE',
        rationale: 'stale competing request',
        expectedVersion: 1,
      })).toThrow('version');
      expect(fixture.db.prepare('SELECT count(*) AS count FROM decisions WHERE job_id = ?').get('job-session-race')).toEqual({ count: 1 });

      let now = 0;
      const limiter = new RequestRateLimiter({ capacity: 1, clock: () => now });
      expect(limiter.consume(sessionA.tokenId).allowed).toBe(true);
      expect(limiter.consume(sessionA.tokenId).allowed).toBe(false);
      expect(limiter.consume(sessionB.tokenId).allowed).toBe(true);
      now = 1_000;
      expect(limiter.consume(sessionA.tokenId).allowed).toBe(true);
      const auditText = JSON.stringify(fixture.db.prepare('SELECT * FROM audit_log').all());
      expect(auditText).not.toContain(bootstrap.initialToken);
      expect(auditText).not.toContain(tokenB);
      expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
    } finally {
      closeStoreFixture(fixture);
    }
  });
});
