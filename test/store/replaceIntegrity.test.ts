import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeStoreFixture,
  createStoreFixture,
  seedAudit,
  seedDecision,
  seedJob,
  type StoreFixture,
} from './testHelpers.js';

let fixture: StoreFixture;

const JOB_COLUMNS = 'job_id, workspace, title, spec_json, state, state_reason, authoritative_status, deciding_decision_id, owner_actor_id, cycle, max_cycles, version, deadline_at, stale_after_s, created_at, updated_at';
const DECISION_COLUMNS = 'decision_id, job_id, cycle, actor_id, session_token_id, request_id, session_hint, decision, rationale, evidence_refs, from_state, to_state, created_at';

function db(): StoreFixture['db'] {
  return fixture.db;
}

function setExternalConnectionPolicy(connection: Database.Database): void {
  connection.pragma('foreign_keys = ON');
  connection.pragma('recursive_triggers = OFF');
}

function replaceJob(connection: Database.Database, sql: 'insert_or_replace' | 'replace'): void {
  const prefix = sql === 'insert_or_replace' ? 'INSERT OR REPLACE' : 'REPLACE';
  connection.prepare(
    `${prefix} INTO jobs(${JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'job-1',
    'C:\\AgentProjects\\fixture',
    'Replacement job',
    '{}',
    'EVIDENCE_READY',
    null,
    null,
    null,
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

function replaceDecision(connection: Database.Database, sql: 'insert_or_replace' | 'replace'): void {
  const prefix = sql === 'insert_or_replace' ? 'INSERT OR REPLACE' : 'REPLACE';
  connection.prepare(
    `${prefix} INTO decisions(${DECISION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'decision-1',
    'job-1',
    0,
    'codex',
    null,
    'request-decision-1',
    null,
    'APPROVE',
    'forged replacement',
    null,
    'EVIDENCE_READY',
    'APPROVED',
    '2026-08-30T00:00:00Z',
  );
}

function replaceAudit(connection: Database.Database, sql: 'insert_or_replace' | 'replace'): void {
  const prefix = sql === 'insert_or_replace' ? 'INSERT OR REPLACE' : 'REPLACE';
  connection.prepare(
    `${prefix} INTO audit_log(seq, ts, actor_id, actor_role, request_id, action, result, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    1,
    '2026-08-30T00:00:01Z',
    'codex',
    'principal',
    'request-forged',
    'forged replacement',
    'ok',
    '1'.repeat(64),
    '2'.repeat(64),
  );
}

function establishRejectedJob(connection: Database.Database): void {
  seedJob(connection);
  seedDecision(connection, 'decision-reject', 'REJECT', 'codex', 'job-1', 0, 'REJECTED');
  connection.prepare(
    "UPDATE jobs SET state = 'REJECTED', authoritative_status = 'REJECTED', deciding_decision_id = ? WHERE job_id = 'job-1'",
  ).run('decision-reject');
}

beforeEach(() => {
  fixture = createStoreFixture();
  setExternalConnectionPolicy(db());
  db().prepare(
    "INSERT INTO actors(actor_id, role, display_name, capabilities_json, disabled, created_at) VALUES ('codex', 'principal', 'Codex', '[]', 0, ?)",
  ).run('2026-08-30T00:00:00Z');
});

afterEach(() => {
  closeStoreFixture(fixture);
});

describe('jobs reject SQLite row replacement with recursive_triggers OFF', () => {
  it('allows a genuinely new job but rejects an ordinary duplicate INSERT', () => {
    seedJob(db(), 'job-new');
    expect(() => seedJob(db(), 'job-new')).toThrow('jobs are durable and cannot be replaced');
  });

  it.each(['insert_or_replace', 'replace'] as const)(
    'rejects %s for an existing job',
    (sql) => {
      seedJob(db());
      expect(() => replaceJob(db(), sql)).toThrow('jobs are durable and cannot be replaced');
    },
  );

  it('keeps a terminal job, its status, and its decision relationship unchanged', () => {
    establishRejectedJob(db());
    const beforeJob = db().prepare("SELECT * FROM jobs WHERE job_id = 'job-1'").get();
    const beforeDecisions = db().prepare(
      "SELECT * FROM decisions WHERE job_id = 'job-1' ORDER BY decision_id",
    ).all();
    const attacker = new Database(fixture.layout.database);
    try {
      setExternalConnectionPolicy(attacker);
      expect(() => replaceJob(attacker, 'insert_or_replace')).toThrow(
        'jobs are durable and cannot be replaced',
      );
    } finally {
      attacker.close();
    }
    expect(db().prepare("SELECT * FROM jobs WHERE job_id = 'job-1'").get()).toEqual(beforeJob);
    expect(db().prepare(
      "SELECT * FROM decisions WHERE job_id = 'job-1' ORDER BY decision_id",
    ).all()).toEqual(beforeDecisions);
  });

  it('rejects an UPSERT conflict path as a durable-row replacement', () => {
    establishRejectedJob(db());
    expect(() => db().prepare(
      "INSERT INTO jobs(job_id, workspace, title, spec_json, state, owner_actor_id, max_cycles, stale_after_s, created_at, updated_at) VALUES ('job-1', 'C:\\\\AgentProjects\\\\fixture', 'Ignored', '{}', 'APPROVED', 'codex', 10, 60, '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z') ON CONFLICT(job_id) DO UPDATE SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = NULL",
    ).run()).toThrow('jobs are durable and cannot be replaced');
  });
});

describe('decisions reject SQLite row replacement with recursive_triggers OFF', () => {
  it('allows a new principal decision and keeps UPDATE/DELETE append-only', () => {
    seedJob(db());
    seedDecision(db(), 'decision-new', 'APPROVE');
    expect(db().prepare(
      "SELECT decision FROM decisions WHERE decision_id = 'decision-new'",
    ).get()).toEqual({ decision: 'APPROVE' });
    expect(() => db().prepare(
      "UPDATE decisions SET rationale = 'changed' WHERE decision_id = 'decision-new'",
    ).run()).toThrow('decisions are append-only');
    expect(() => db().prepare(
      "DELETE FROM decisions WHERE decision_id = 'decision-new'",
    ).run()).toThrow('decisions are append-only');
  });

  it.each(['insert_or_replace', 'replace'] as const)(
    'rejects %s and preserves the original decision used by T2',
    (sql) => {
      seedJob(db());
      seedDecision(db(), 'decision-1', 'RETEST', 'codex', 'job-1', 0, 'IN_PROGRESS');
      const before = db().prepare(
        "SELECT * FROM decisions WHERE decision_id = 'decision-1'",
      ).get();
      expect(() => replaceDecision(db(), sql)).toThrow(
        'decisions are append-only and cannot be replaced',
      );
      expect(db().prepare(
        "SELECT * FROM decisions WHERE decision_id = 'decision-1'",
      ).get()).toEqual(before);
      expect(() => db().prepare(
        "UPDATE jobs SET state = 'APPROVED', authoritative_status = 'APPROVED', deciding_decision_id = 'decision-1' WHERE job_id = 'job-1'",
      ).run()).toThrow('authoritative_status requires a granting principal decision');
    },
  );
});

describe('AUDIT-07/O2-02 audit_log rejects replacement and self-repair with recursive_triggers OFF', () => {
  it('allows two normal AUTOINCREMENT inserts without an explicit seq', () => {
    db().exec(
      'CREATE TEMP TABLE audit_seq_probe(value); ' +
      'CREATE TEMP TRIGGER audit_seq_probe_before_insert BEFORE INSERT ON audit_log ' +
      'BEGIN INSERT INTO audit_seq_probe(value) VALUES (NEW.seq); END;',
    );
    seedAudit(db());
    seedAudit(db(), 'codex');
    const rows = db().prepare('SELECT seq FROM audit_log ORDER BY seq').all();
    const observedNewSeq = db().prepare('SELECT value FROM audit_seq_probe').all();
    expect(rows).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(observedNewSeq).toEqual([{ value: -1 }, { value: -1 }]);
  });

  it('keeps UPDATE/DELETE append-only and rejects explicit-seq replacements', () => {
    seedAudit(db());
    const before = db().prepare('SELECT * FROM audit_log WHERE seq = 1').get();
    expect(() => db().prepare(
      "UPDATE audit_log SET action = 'changed' WHERE seq = 1",
    ).run()).toThrow('audit_log is append-only');
    expect(() => db().prepare('DELETE FROM audit_log WHERE seq = 1').run()).toThrow(
      'audit_log is append-only',
    );
    expect(() => replaceAudit(db(), 'insert_or_replace')).toThrow(
      'audit_log is append-only and cannot be replaced',
    );
    expect(() => replaceAudit(db(), 'replace')).toThrow(
      'audit_log is append-only and cannot be replaced',
    );
    expect(db().prepare('SELECT * FROM audit_log WHERE seq = 1').get()).toEqual(before);
  });
});
