import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AuditWriter, verifyAuditChain } from '../../src/authority/audit.js';
import { bootstrapProduction } from '../../src/authority/bootstrap.js';
import { applyTransition } from '../../src/domain/decide.js';
import {
  addEvidence,
  EvidenceError,
  listEvidence,
} from '../../src/domain/evidence.js';
import {
  addRuntimeEvidence,
  type EvidenceRecord,
} from '../../src/domain/evidence.js';
import {
  ensureArtifactStagingDirectory,
  listArtifacts,
  registerArtifact,
  registerRuntimeArtifact,
  verifyArtifactFile,
  type ArtifactOptions,
} from '../../src/domain/artifacts.js';
import { hashAccessToken, type VerifiedActorAuthInfo } from '../../src/mcp/auth.js';
import { dispatchQa, type Phase6RunOptions } from '../../src/domain/runs.js';
import { closeStoreFixture, createStoreFixture, seedJob, type StoreFixture } from './testHelpers.js';

let fixture: StoreFixture;
let audit: AuditWriter;
let principal: VerifiedActorAuthInfo;
let worker: VerifiedActorAuthInfo;
let phase6: Phase6RunOptions;
let artifacts: ArtifactOptions;

function actor(
  actorId: string,
  role: 'principal' | 'worker',
  capabilities: readonly ('job:create' | 'job:read' | 'job:decide' | 'qa:request' | 'work:report' | 'evidence:add' | 'artifact:register')[],
  tokenId: string,
): VerifiedActorAuthInfo {
  return {
    clientId: actorId,
    scopes: ['mcp'],
    tokenId,
    sessionLabel: actorId + '-session',
    expiresAt: Number.MAX_SAFE_INTEGER,
    actorId,
    role,
    capabilities,
  };
}

function dispatch(): { readonly runId: string; readonly lease: string } {
  const result = dispatchQa(fixture.db, audit, principal, {
    job_id: 'job-1',
    cycle: 0,
    expected_version: 1,
    requests: [{ worker_id: 'fixture-worker', task: 'collect evidence' }],
  }, 'phase7-dispatch', phase6);
  return { runId: result.runs[0]!.run_id, lease: result.runtimeLeases[0]!.lease };
}

beforeEach(() => {
  fixture = createStoreFixture();
  audit = new AuditWriter(fixture.db);
  bootstrapProduction(fixture.db, audit);
  fixture.db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?) ',
  ).run('worker', 'worker', 'Fixture Worker', '["artifact:register","evidence:add","work:report"]', 0, '2026-09-01T00:00:00Z');
  fixture.db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ',
  ).run('worker-token', 'worker', hashAccessToken('worker-secret'), 'worker', 0, null, null, '2026-09-01T00:00:00Z');
  seedJob(fixture.db, 'job-1', 'IN_PROGRESS');
  fixture.db.prepare('UPDATE jobs SET workspace = ? WHERE job_id = ?').run(fixture.workspace, 'job-1');
  principal = actor('codex', 'principal', [
    'artifact:register', 'evidence:add', 'job:create', 'job:decide', 'job:read', 'qa:request',
  ], 'token-initial');
  worker = actor('worker', 'worker', ['artifact:register', 'evidence:add', 'work:report'], 'worker-token');
  phase6 = {
    registry: {
      version: 1,
      workers: [{
        worker_id: 'fixture-worker',
        actor_id: 'worker',
        enabled: true,
        adapter: 'process',
        delivery: 'pipe',
        executable: process.execPath,
        argv_template: [],
        cwd_policy: 'job_workspace',
        environment_allowlist: [],
        default_timeout_ms: 300_000,
        hard_timeout_ms: 900_000,
        max_output_bytes: 4 * 1024 * 1024,
        max_messages: 256,
      }],
    },
    leaseKey: Buffer.alloc(32, 7),
    clock: () => Date.parse('2026-09-01T00:00:00Z'),
  };
  artifacts = {
    artifactsRoot: fixture.layout.artifacts,
    leaseKey: phase6.leaseKey,
    clock: () => Date.parse('2026-09-01T00:00:00Z'),
    platform: process.platform,
  };
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('Phase 7 evidence and artifact domain', () => {
  it('admits lease-bound worker evidence and a copied artifact with derived trust', () => {
    const run = dispatch();
    const staging = ensureArtifactStagingDirectory(
      fixture.layout.artifacts,
      'job-1',
      0,
      run.runId,
    );
    writeFileSync(join(staging, 'result.txt'), 'phase7 artifact', 'utf8');

    const artifact = registerArtifact(fixture.db, audit, worker, {
      job_id: 'job-1',
      cycle: 0,
      run_id: run.runId,
      source_path: 'result.txt',
      kind: 'report',
      mime: 'text/plain',
      label: 'worker result',
      lease: run.lease,
      idempotency_key: randomUUID(),
    }, 'artifact-request', artifacts);
    expect(artifact).toMatchObject({ job_id: 'job-1', cycle: 0, run_id: run.runId, bytes: 15 });
    expect(verifyArtifactFile(fixture.layout.artifacts, artifact)).toBe(true);

    const evidence = addEvidence(fixture.db, audit, worker, {
      job_id: 'job-1',
      cycle: 0,
      run_id: run.runId,
      kind: 'assertion',
      severity: 'info',
      summary: 'The worker produced a bounded result.',
      detail: { source: 'fixture' },
      artifact_id: artifact.artifact_id,
      lease: run.lease,
      idempotency_key: randomUUID(),
    }, 'evidence-request', artifacts);
    expect(evidence).toMatchObject({
      job_id: 'job-1',
      run_id: run.runId,
      source_actor: 'worker',
      trust: 'untrusted',
      artifact_id: artifact.artifact_id,
    });
    expect(() => fixture.db.prepare('UPDATE evidence SET summary = ? WHERE evidence_id = ?').run('changed', evidence.evidence_id)).toThrow('append-only');
    expect(() => fixture.db.prepare('DELETE FROM evidence WHERE evidence_id = ?').run(evidence.evidence_id)).toThrow('append-only');
    expect(verifyAuditChain(fixture.db)).toEqual({ valid: true });
  });

  it('keeps principal evidence distinct and pages bounded metadata', () => {
    const evidence = addEvidence(fixture.db, audit, principal, {
      job_id: 'job-1',
      cycle: 0,
      kind: 'review',
      summary: 'Principal observation',
      idempotency_key: randomUUID(),
    }, 'principal-evidence', artifacts);
    expect(evidence.trust).toBe('principal');
    expect(evidence.source_actor).toBe('codex');

    const page = listEvidence(fixture.db, principal, { job_id: 'job-1', limit: 1 });
    expect(page.evidence).toHaveLength(1);
    expect(page.evidence[0]).toMatchObject({ evidence_id: evidence.evidence_id });
    expect(listArtifacts(fixture.db, principal, { job_id: 'job-1' })).toEqual({ artifacts: [] });
  });

  it('rejects stale leases, path traversal, and incompatible evidence references', () => {
    const run = dispatch();
    expect(() => addEvidence(fixture.db, audit, worker, {
      job_id: 'job-1',
      cycle: 0,
      run_id: run.runId,
      kind: 'assertion',
      summary: 'late',
      lease: run.lease,
      idempotency_key: randomUUID(),
    }, 'evidence-stale', { ...artifacts, clock: () => Date.parse('2030-01-01T00:00:00Z') })).toThrow(EvidenceError);

    writeFileSync(join(fixture.workspace, 'principal.txt'), 'principal file', 'utf8');
    expect(() => registerArtifact(fixture.db, audit, principal, {
      job_id: 'job-1',
      cycle: 0,
      source_path: '../outside.txt',
      kind: 'report',
      idempotency_key: randomUUID(),
    }, 'artifact-traversal', artifacts)).toThrow('prohibited');

    expect(() => addEvidence(fixture.db, audit, principal, {
      job_id: 'job-1',
      cycle: 0,
      kind: 'review',
      summary: 'foreign artifact',
      artifact_id: 'missing-artifact',
      idempotency_key: randomUUID(),
    }, 'evidence-foreign-artifact', artifacts)).toThrow('artifact reference');
  });

  it('enforces append-only database guards and idempotent artifact replay', () => {
    writeFileSync(join(fixture.workspace, 'principal.txt'), 'principal file', 'utf8');
    const input = {
      job_id: 'job-1',
      cycle: 0,
      source_path: 'principal.txt',
      kind: 'report',
      idempotency_key: randomUUID(),
    } as const;
    const first = registerArtifact(fixture.db, audit, principal, input, 'artifact-idempotent', artifacts);
    const replay = registerArtifact(fixture.db, audit, principal, input, 'artifact-idempotent-replay', artifacts);
    expect(replay).toEqual(first);
    expect(() => fixture.db.prepare('UPDATE artifacts SET label = ? WHERE artifact_id = ?').run('changed', first.artifact_id)).toThrow('append-only');
    expect(() => fixture.db.prepare('DELETE FROM artifacts WHERE artifact_id = ?').run(first.artifact_id)).toThrow('append-only');
    expect(() => fixture.db.prepare('INSERT OR REPLACE INTO artifacts(artifact_id, job_id, cycle, kind, rel_path, bytes, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(first.artifact_id, 'job-1', 0, 'replace', first.rel_path, first.bytes, first.sha256, 'codex', first.created_at)).toThrow();
  });

  it('validates decision references and generates a verifiable PACKAGE manifest', () => {
    fixture.db.prepare("UPDATE jobs SET state = 'EVIDENCE_READY' WHERE job_id = ?").run('job-1');
    const evidence = addEvidence(fixture.db, audit, principal, {
      job_id: 'job-1',
      cycle: 0,
      kind: 'review',
      summary: 'ready for authority review',
      idempotency_key: randomUUID(),
    }, 'evidence-before-decision', artifacts);
    const approved = applyTransition(fixture.db, audit, principal, {
      jobId: 'job-1',
      cycle: 0,
      decision: 'APPROVE',
      rationale: 'The evidence is sufficient.',
      evidenceRefs: [evidence.evidence_id],
      expectedVersion: 1,
      requestId: 'approve-with-evidence',
    });
    const packaged = applyTransition(fixture.db, audit, principal, {
      jobId: 'job-1',
      cycle: 0,
      decision: 'PACKAGE',
      rationale: 'Create the bounded handoff manifest.',
      expectedVersion: approved.version,
      requestId: 'package-with-manifest',
    }, artifacts.clock, {
      artifactsRoot: artifacts.artifactsRoot,
      ...(artifacts.platform === undefined ? {} : { platform: artifacts.platform }),
    });
    expect(packaged.state).toBe('PACKAGING');
    const manifest = fixture.db.prepare(
      "SELECT artifact_id, rel_path, bytes, sha256, created_by, run_id FROM artifacts WHERE job_id = ? AND cycle = ? AND kind = 'manifest'",
    ).get('job-1', 0) as Record<string, unknown>;
    expect(manifest).toMatchObject({ created_by: 'codex', run_id: null });
    expect(existsSync(join(fixture.layout.artifacts, String(manifest.rel_path).replaceAll('/', process.platform === 'win32' ? '\\' : '/')))).toBe(true);
    expect(verifyArtifactFile(fixture.layout.artifacts, {
      rel_path: String(manifest.rel_path),
      bytes: Number(manifest.bytes),
      sha256: String(manifest.sha256),
    })).toBe(true);
    const delivered = applyTransition(fixture.db, audit, principal, {
      jobId: 'job-1',
      cycle: 0,
      decision: 'DELIVER',
      rationale: 'The manifest is present and verified.',
      expectedVersion: packaged.version,
      requestId: 'deliver-with-manifest',
    }, artifacts.clock, {
      artifactsRoot: artifacts.artifactsRoot,
      ...(artifacts.platform === undefined ? {} : { platform: artifacts.platform }),
    });
    expect(delivered.state).toBe('READY_FOR_DELIVERY');

    expect(() => applyTransition(fixture.db, audit, principal, {
      jobId: 'job-1',
      cycle: 0,
      decision: 'COMPLETE',
      rationale: 'missing reference',
      evidenceRefs: ['missing-evidence'],
      expectedVersion: delivered.version,
      requestId: 'bad-reference',
    })).toThrow('Every evidence reference');
  });

  it('uses the same lease-bound path for runtime output helpers', () => {
    const run = dispatch();
    const staging = ensureArtifactStagingDirectory(fixture.layout.artifacts, 'job-1', 0, run.runId);
    writeFileSync(join(staging, 'runtime.txt'), 'runtime artifact', 'utf8');
    const artifact = registerRuntimeArtifact(fixture.db, audit, run.lease, {
      job_id: 'job-1', cycle: 0, run_id: run.runId, source_path: 'runtime.txt', kind: 'runtime',
    }, 'runtime-artifact', artifacts);
    const evidence = addRuntimeEvidence(fixture.db, audit, run.lease, {
      job_id: 'job-1', cycle: 0, run_id: run.runId, kind: 'runtime', summary: 'runtime evidence', artifact_id: artifact.artifact_id,
    }, 'runtime-evidence', artifacts);
    expect((evidence as EvidenceRecord).trust).toBe('untrusted');
  });

  it('redacts worker-controlled secrets before evidence and artifact retention', () => {
    const run = dispatch();
    const staging = ensureArtifactStagingDirectory(fixture.layout.artifacts, 'job-1', 0, run.runId);
    writeFileSync(join(staging, 'secret.txt'), 'worker artifact', 'utf8');
    const artifact = registerRuntimeArtifact(fixture.db, audit, run.lease, {
      job_id: 'job-1',
      cycle: 0,
      run_id: run.runId,
      source_path: 'secret.txt',
      kind: 'report',
      label: 'Bearer worker-secret',
    }, 'runtime-secret-artifact', artifacts);
    const evidence = addRuntimeEvidence(fixture.db, audit, run.lease, {
      job_id: 'job-1',
      cycle: 0,
      run_id: run.runId,
      kind: 'report',
      summary: `Bearer worker-secret lease=${run.lease}`,
      detail: { lease: run.lease, token_id: 'safe-token-id', note: 'safe' },
      artifact_id: artifact.artifact_id,
    }, 'runtime-secret-evidence', artifacts);

    expect(evidence.summary).toContain('[REDACTED]');
    expect(evidence.summary).not.toContain(run.lease);
    expect(evidence.detail).toEqual({ lease: '[REDACTED]', token_id: 'safe-token-id', note: 'safe' });
    expect(artifact.label).toBe('Bearer [REDACTED]');
    const persisted = JSON.stringify(fixture.db.prepare(
      'SELECT detail_json FROM evidence UNION ALL SELECT label FROM artifacts UNION ALL SELECT detail_json FROM audit_log',
    ).all());
    expect(persisted).not.toContain(run.lease);
  });
});
