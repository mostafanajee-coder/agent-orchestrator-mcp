import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CloudSyncEnvironment } from '../../src/config/cloudSync.js';
import type { CommandContext } from '../../src/commands/context.js';
import { runInit } from '../../src/commands/init.js';
import { stateLayout, type StateLayout } from '../../src/config/stateRoot.js';
import { FakeSecurityProvider } from '../helpers/fakeSecurity.js';

export interface StoreFixture {
  readonly workspace: string;
  readonly root: string;
  readonly layout: StateLayout;
  readonly security: FakeSecurityProvider;
  readonly context: CommandContext;
  readonly db: Database.Database;
}

export function createStoreFixture(): StoreFixture {
  const workspace = mkdtempSync(join(tmpdir(), 'aom-phase3-store-'));
  const root = join(workspace, 'state');
  const security = new FakeSecurityProvider();
  const cloudSync: CloudSyncEnvironment = {
    platform: process.platform,
    env: {},
    profileDir: workspace,
    readFileIfPresent: () => undefined,
  };
  const context: CommandContext = {
    layout: stateLayout(root, process.platform),
    security,
    cloudSync,
    platform: process.platform,
    legacyRoots: [],
  };
  runInit(context);
  const db = new Database(context.layout.database);
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = ON');
  return { workspace, root, layout: context.layout, security, context, db };
}

export function closeStoreFixture(fixture: StoreFixture): void {
  if (fixture.db.open) fixture.db.close();
  rmSync(fixture.workspace, { recursive: true, force: true });
}

export function seedActors(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('codex', 'principal', 'Codex', '["job:decide"]', 0, '2026-08-30T00:00:00Z');
  insert.run('worker', 'worker', 'Worker', '[]', 0, '2026-08-30T00:00:00Z');
  insert.run('observer', 'observer', 'Observer', '[]', 0, '2026-08-30T00:00:00Z');
}

export function seedToken(db: Database.Database, tokenId = 'token-1'): void {
  db.prepare(
    'INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    tokenId,
    'codex',
    'a'.repeat(64),
    'codex-session-a',
    0,
    null,
    null,
    '2026-08-30T00:00:00Z',
  );
}

export function seedJob(
  db: Database.Database,
  jobId = 'job-1',
  state = 'EVIDENCE_READY',
  authoritativeStatus: string | null = null,
  decidingDecisionId: string | null = null,
): void {
  db.prepare(
    'INSERT INTO jobs(job_id, workspace, title, spec_json, state, state_reason, authoritative_status, deciding_decision_id, owner_actor_id, cycle, max_cycles, version, deadline_at, stale_after_s, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    jobId,
    'C:\\\\AgentProjects\\\\fixture',
    'Fixture job',
    '{}',
    state,
    null,
    authoritativeStatus,
    decidingDecisionId,
    'codex',
    0,
    10,
    1,
    null,
    60,
    '2026-08-30T00:00:00Z',
    '2026-08-30T00:00:00Z',
  );
}

export function seedDecision(
  db: Database.Database,
  decisionId: string,
  decision: string,
  actorId = 'codex',
  jobId = 'job-1',
  cycle = 0,
  toState = 'APPROVED',
): void {
  db.prepare(
    'INSERT INTO decisions(decision_id, job_id, cycle, actor_id, session_token_id, request_id, session_hint, decision, rationale, evidence_refs, from_state, to_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    decisionId,
    jobId,
    cycle,
    actorId,
    null,
    'request-' + decisionId,
    null,
    decision,
    'fixture rationale',
    null,
    'EVIDENCE_READY',
    toState,
    '2026-08-30T00:00:00Z',
  );
}

export function seedRun(
  db: Database.Database,
  runId = 'run-1',
  jobId = 'job-1',
  cycle = 0,
  verdict: string | null = null,
): void {
  db.prepare(
    'INSERT INTO worker_runs(run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, exit_code, pid, usage_json, stderr_tail, attempt, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    runId,
    jobId,
    cycle,
    'worker',
    'fixture',
    '{}',
    verdict === null ? 'SUCCEEDED' : 'SUCCEEDED',
    verdict,
    null,
    0,
    null,
    null,
    null,
    1,
    '2026-08-30T00:00:00Z',
    '2026-08-30T00:00:01Z',
    '2026-08-30T00:00:00Z',
  );
}

export function seedArtifact(
  db: Database.Database,
  artifactId = 'artifact-1',
  jobId = 'job-1',
  relPath = 'report.txt',
): void {
  db.prepare(
    'INSERT INTO artifacts(artifact_id, job_id, cycle, run_id, kind, mime, label, rel_path, bytes, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    artifactId,
    jobId,
    0,
    null,
    'report',
    'text/plain',
    'report',
    relPath,
    12,
    'b'.repeat(64),
    'codex',
    '2026-08-30T00:00:00Z',
  );
}

export function seedAudit(db: Database.Database, seqActor = 'codex'): void {
  db.prepare(
    'INSERT INTO audit_log(ts, actor_id, actor_role, session_token_id, request_id, session_hint, action, job_id, cycle, capability, subject_type, subject_id, from_state, to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    '2026-08-30T00:00:00Z',
    seqActor,
    'principal',
    null,
    'audit-request',
    null,
    'fixture',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'ok',
    null,
    '0'.repeat(64),
    '1'.repeat(64),
  );
}
