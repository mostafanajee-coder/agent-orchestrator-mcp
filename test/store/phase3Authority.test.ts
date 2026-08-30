import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeStoreFixture,
  createStoreFixture,
  seedArtifact,
  seedActors,
  seedAudit,
  seedDecision,
  seedJob,
  seedRun,
  seedToken,
  type StoreFixture,
} from './testHelpers.js';

let fixture: StoreFixture;

function db(): StoreFixture['db'] {
  return fixture.db;
}

function referenceSnapshot(): string {
  return JSON.stringify({
    grants: db().prepare(
      'SELECT decision, authoritative_status FROM decision_grants ORDER BY decision',
    ).all(),
    statuses: db().prepare(
      'SELECT authoritative_status, rank, terminal FROM authoritative_statuses ORDER BY rank',
    ).all(),
  });
}

function establishTerminalJob(): void {
  seedDecision(db(), 'decision-approved', 'APPROVE', 'codex', 'job-1', 0, 'APPROVED');
  db().prepare(
    "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
  ).run('decision-approved');
  seedDecision(db(), 'decision-complete', 'COMPLETE', 'codex', 'job-1', 0, 'JOB_COMPLETED');
  db().prepare(
    "UPDATE jobs SET state = 'JOB_COMPLETED', authoritative_status = 'JOB_COMPLETED', deciding_decision_id = ? WHERE job_id = 'job-1'",
  ).run('decision-complete');
}

function expectTerminalReopenToFail(): void {
  seedDecision(db(), 'decision-reopen', 'APPROVE', 'codex', 'job-1', 0, 'JOB_COMPLETED');
  expect(() => db().prepare(
    "UPDATE jobs SET authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
  ).run('decision-reopen')).toThrow('authoritative_status is terminal or would regress');
}

beforeEach(() => {
  fixture = createStoreFixture();
  seedActors(db());
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('Phase 3 raw-SQL authority matrix', () => {
  it('SQL-01 rejects a second principal actor', () => {
    expect(() => db().prepare(
      "INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES ('second', 'principal', 'Second', '[]', 0, ?)",
    ).run('2026-08-30T00:00:00Z')).toThrow();
  });

  it('SQL-02 rejects promoting a worker to principal', () => {
    expect(() => db().prepare(
      "UPDATE actors SET role = 'principal' WHERE actor_id = 'worker'",
    ).run()).toThrow();
  });

  it('SQL-04 rejects invalid actor role and disabled domains', () => {
    expect(() => db().prepare(
      "INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES ('bad', 'rogue', 'Bad', '[]', 0, ?)",
    ).run('2026-08-30T00:00:00Z')).toThrow();
    expect(() => db().prepare(
      "INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES ('bad-disabled', 'worker', 'Bad', '[]', 2, ?)",
    ).run('2026-08-30T00:00:00Z')).toThrow();
  });

  it('SQL-05 rejects an actor_tokens row for an unknown actor', () => {
    expect(() => db().prepare(
      "INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES ('bad-token', 'missing', ?, 'bad', 0, NULL, NULL, ?)",
    ).run('c'.repeat(64), '2026-08-30T00:00:00Z')).toThrow();
  });

  it('SQL-07 rejects duplicate token digests', () => {
    seedToken(db());
    expect(() => db().prepare(
      "INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES ('token-2', 'worker', ?, 'worker', 0, NULL, NULL, ?)",
    ).run('a'.repeat(64), '2026-08-30T00:00:00Z')).toThrow();
  });

  it('SQL-08 rejects malformed token digests and booleans', () => {
    expect(() => db().prepare(
      "INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES ('bad-token', 'codex', 'not-a-digest', 'bad', 0, NULL, NULL, ?)",
    ).run('2026-08-30T00:00:00Z')).toThrow();
    expect(() => db().prepare(
      "INSERT INTO actor_tokens(token_id, actor_id, token_sha256, label, disabled, expires_at, last_used_at, created_at) VALUES ('bad-disabled', 'codex', ?, 'bad', 2, NULL, NULL, ?)",
    ).run('d'.repeat(64), '2026-08-30T00:00:00Z')).toThrow();
  });

  it('SQL-09 freezes status terminality and preserves T3 afterwards', () => {
    const before = referenceSnapshot();
    expect(() => db().prepare(
      "UPDATE authoritative_statuses SET terminal = 0 WHERE authoritative_status = 'JOB_COMPLETED'",
    ).run()).toThrow('authoritative_statuses is immutable');
    expect(referenceSnapshot()).toBe(before);
    seedJob(db());
    establishTerminalJob();
    expectTerminalReopenToFail();
  });

  it('SQL-10 freezes status ranks and preserves T3 afterwards', () => {
    const before = referenceSnapshot();
    expect(() => db().prepare(
      "UPDATE authoritative_statuses SET rank = 99 WHERE authoritative_status = 'APPROVED'",
    ).run()).toThrow('authoritative_statuses is immutable');
    expect(referenceSnapshot()).toBe(before);
    seedJob(db());
    establishTerminalJob();
    expectTerminalReopenToFail();
  });

  it('SQL-11 rejects adding and deleting authoritative statuses', () => {
    const before = referenceSnapshot();
    expect(() => db().prepare(
      "INSERT INTO authoritative_statuses(authoritative_status, rank, terminal) VALUES ('UNAPPROVED', 5, 0)",
    ).run()).toThrow('authoritative_statuses is immutable');
    expect(() => db().prepare(
      "DELETE FROM authoritative_statuses WHERE authoritative_status = 'REJECTED'",
    ).run()).toThrow('authoritative_statuses is immutable');
    expect(referenceSnapshot()).toBe(before);
    seedJob(db());
    establishTerminalJob();
    expectTerminalReopenToFail();
  });

  it('SQL-12 rejects widening decision grants', () => {
    const before = referenceSnapshot();
    expect(() => db().prepare(
      "INSERT INTO decision_grants(decision, authoritative_status) VALUES ('APPROVE', 'REJECTED')",
    ).run()).toThrow('decision_grants is immutable');
    expect(referenceSnapshot()).toBe(before);
  });

  it('SQL-13 rejects updating and deleting decision grants', () => {
    const before = referenceSnapshot();
    expect(() => db().prepare(
      "UPDATE decision_grants SET authoritative_status = 'REJECTED' WHERE decision = 'APPROVE'",
    ).run()).toThrow('decision_grants is immutable');
    expect(() => db().prepare(
      "DELETE FROM decision_grants WHERE decision = 'APPROVE'",
    ).run()).toThrow('decision_grants is immutable');
    expect(referenceSnapshot()).toBe(before);
  });

  it('SQL-14 rejects a decision authored by a worker', () => {
    seedJob(db());
    expect(() => seedDecision(db(), 'worker-decision', 'APPROVE', 'worker')).toThrow(
      'decisions require an enabled principal actor',
    );
  });

  it('SQL-15 rejects a decision authored by a disabled principal', () => {
    seedJob(db());
    db().prepare("UPDATE actors SET disabled = 1 WHERE actor_id = 'codex'").run();
    expect(() => seedDecision(db(), 'disabled-decision', 'APPROVE', 'codex')).toThrow(
      'decisions require an enabled principal actor',
    );
  });

  it('SQL-16 rejects a non-granting RETEST decision used for approval', () => {
    seedJob(db());
    seedDecision(db(), 'retest-decision', 'RETEST', 'codex', 'job-1', 0, 'APPROVED');
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('retest-decision')).toThrow(
      'authoritative_status requires a granting principal decision',
    );
  });

  it('SQL-17 rejects APPROVE while stamping JOB_COMPLETED', () => {
    seedJob(db());
    seedDecision(db(), 'wrong-grant', 'APPROVE', 'codex', 'job-1', 0, 'JOB_COMPLETED');
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'JOB_COMPLETED', authoritative_status = 'JOB_COMPLETED', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('wrong-grant')).toThrow(
      'authoritative_status requires a granting principal decision',
    );
  });

  it('SQL-18 rejects a granting decision from another job', () => {
    seedJob(db());
    seedJob(db(), 'job-2');
    seedDecision(db(), 'other-job', 'APPROVE', 'codex', 'job-2', 0, 'APPROVED');
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('other-job')).toThrow('authoritative_status requires a granting principal decision');
  });

  it('SQL-19 rejects a granting decision from another cycle', () => {
    seedJob(db());
    seedDecision(db(), 'other-cycle', 'APPROVE', 'codex', 'job-1', 1, 'APPROVED');
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('other-cycle')).toThrow('authoritative_status requires a granting principal decision');
  });

  it('SQL-20 rejects a decision whose to_state does not match the new job state', () => {
    seedJob(db());
    seedDecision(db(), 'wrong-state', 'APPROVE', 'codex', 'job-1', 0, 'IN_PROGRESS');
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('wrong-state')).toThrow('authoritative_status requires a granting principal decision');
  });

  it('SQL-21 rejects a previously valid decision after disabling its principal', () => {
    seedJob(db());
    seedDecision(db(), 'disabled-at-use', 'APPROVE');
    db().prepare("UPDATE actors SET disabled = 1 WHERE actor_id = 'codex'").run();
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('disabled-at-use')).toThrow(
      'authoritative_status requires a granting principal decision',
    );
  });

  it('SQL-22 rejects a new authoritative status without a decision', () => {
    seedJob(db());
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = NULL WHERE job_id = 'job-1'",
    ).run()).toThrow('authoritative_status requires a granting principal decision');
  });

  it('SQL-23 rejects clearing an authoritative status', () => {
    seedJob(db());
    seedDecision(db(), 'valid-approval', 'APPROVE');
    db().prepare(
      "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('valid-approval');
    expect(() => db().prepare(
      "UPDATE jobs SET authoritative_status = NULL WHERE job_id = 'job-1'",
    ).run()).toThrow('authoritative_status requires a granting principal decision');
  });

  it('SQL-24 rejects worker PASS as an authority source', () => {
    seedJob(db());
    seedRun(db(), 'pass-run', 'job-1', 0, 'PASS');
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = NULL WHERE job_id = 'job-1'",
    ).run()).toThrow('authoritative_status requires a granting principal decision');
  });

  it('SQL-25 rejects updating any decision column', () => {
    seedJob(db());
    seedDecision(db(), 'immutable-decision', 'APPROVE');
    expect(() => db().prepare(
      "UPDATE decisions SET rationale = 'changed' WHERE decision_id = 'immutable-decision'",
    ).run()).toThrow('decisions are append-only');
  });

  it('SQL-26 rejects deleting any decision row', () => {
    seedJob(db());
    seedDecision(db(), 'delete-decision', 'APPROVE');
    expect(() => db().prepare(
      "DELETE FROM decisions WHERE decision_id = 'delete-decision'",
    ).run()).toThrow('decisions are append-only');
  });

  it('SQL-27 rejects an authoritative state without a matching status', () => {
    seedJob(db());
    expect(() => db().prepare(
      "UPDATE jobs SET state = 'APPROVED' WHERE job_id = 'job-1'",
    ).run()).toThrow('authoritative state requires the matching authoritative_status');
  });

  it('SQL-28 rejects reopening JOB_COMPLETED with a syntactically matching attempt', () => {
    seedJob(db());
    establishTerminalJob();
    expectTerminalReopenToFail();
  });

  it('SQL-29 rejects lowering a non-terminal authoritative rank', () => {
    seedJob(db());
    seedDecision(db(), 'ready-decision', 'DELIVER', 'codex', 'job-1', 0, 'READY_FOR_DELIVERY');
    db().prepare(
      "UPDATE jobs SET state = 'READY_FOR_DELIVERY', authoritative_status = 'READY_FOR_DELIVERY', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('ready-decision');
    seedDecision(db(), 'lower-decision', 'APPROVE', 'codex', 'job-1', 0, 'READY_FOR_DELIVERY');
    expect(() => db().prepare(
      "UPDATE jobs SET authoritative_status = 'APPROVED', deciding_decision_id = ? WHERE job_id = 'job-1'",
    ).run('lower-decision')).toThrow('authoritative_status is terminal or would regress');
  });

  it('SQL-30 rejects updating and deleting audit rows', () => {
    seedAudit(db());
    expect(() => db().prepare(
      "UPDATE audit_log SET action = 'changed' WHERE seq = 1",
    ).run()).toThrow('audit_log is append-only');
    expect(() => db().prepare(
      'DELETE FROM audit_log WHERE seq = 1',
    ).run()).toThrow('audit_log is append-only');
  });

  it('SQL-31 rejects a job with an unknown owner actor', () => {
    expect(() => db().prepare(
      "INSERT INTO jobs(job_id, workspace, title, spec_json, state, state_reason, authoritative_status, deciding_decision_id, owner_actor_id, cycle, max_cycles, version, deadline_at, stale_after_s, created_at, updated_at) VALUES ('bad-job', 'C:\\\\AgentProjects\\\\fixture', 'Bad', '{}', 'CREATED', NULL, NULL, NULL, 'missing', 0, 10, 1, NULL, 60, ?, ?)",
    ).run('2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z')).toThrow();
  });

  it('SQL-32 rejects a row with an unknown foreign key', () => {
    expect(() => db().prepare(
      "INSERT INTO decisions(decision_id, job_id, cycle, actor_id, session_token_id, request_id, session_hint, decision, rationale, evidence_refs, from_state, to_state, created_at) VALUES ('bad-fk', 'missing-job', 0, 'codex', NULL, 'request', NULL, 'APPROVE', 'rationale', NULL, 'EVIDENCE_READY', 'APPROVED', ?)",
    ).run('2026-08-30T00:00:00Z')).toThrow();
  });

  it('SQL-33 rejects duplicate artifact job paths', () => {
    seedJob(db());
    seedArtifact(db());
    expect(() => seedArtifact(db(), 'artifact-2', 'job-1', 'report.txt')).toThrow();
  });

  it('SQL-34 rejects invalid enum, boolean, and nonnegative domains', () => {
    seedJob(db());
    expect(() => db().prepare(
      "INSERT INTO worker_runs(run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, exit_code, pid, usage_json, stderr_tail, attempt, started_at, ended_at, created_at) VALUES ('bad-run', 'job-1', 0, 'worker', 'fixture', '{}', 'BAD', NULL, NULL, 0, NULL, NULL, NULL, 1, NULL, NULL, ?)",
    ).run('2026-08-30T00:00:00Z')).toThrow();
    expect(() => db().prepare(
      "INSERT INTO worker_runs(run_id, job_id, cycle, worker_id, adapter, request_json, status, worker_verdict, failure_class, exit_code, pid, usage_json, stderr_tail, attempt, started_at, ended_at, created_at) VALUES ('negative-run', 'job-1', -1, 'worker', 'fixture', '{}', 'PENDING', NULL, NULL, 0, NULL, NULL, NULL, 1, NULL, NULL, ?)",
    ).run('2026-08-30T00:00:00Z')).toThrow();
  });

  it('SQL-35 rejects a lease whose job/cycle disagree with its run', () => {
    seedJob(db());
    seedJob(db(), 'job-2');
    seedRun(db(), 'run-1', 'job-1', 0);
    expect(() => db().prepare(
      "INSERT INTO leases(lease_id, run_id, job_id, cycle, actor_id, nonce, expires_at, consumed_at, created_at) VALUES ('lease-1', 'run-1', 'job-2', 0, 'worker', 'nonce', ?, NULL, ?)",
    ).run('2026-08-30T01:00:00Z', '2026-08-30T00:00:00Z')).toThrow();
  });
});
