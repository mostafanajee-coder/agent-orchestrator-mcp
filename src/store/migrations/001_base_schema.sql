CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at TEXT NOT NULL CHECK (length(trim(applied_at)) > 0)
);

CREATE TABLE actors (
  actor_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(actor_id)) > 0),
  role TEXT NOT NULL CHECK (role IN ('principal', 'worker', 'observer', 'system')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  capabilities_json TEXT NOT NULL CHECK (length(trim(capabilities_json)) > 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE UNIQUE INDEX ux_actors_single_principal
  ON actors(role)
  WHERE role = 'principal';

CREATE TABLE actor_tokens (
  token_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(token_id)) > 0),
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  token_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(token_sha256) = 64
      AND token_sha256 NOT GLOB '*[^0-9A-Fa-f]*'
    ),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE INDEX ix_actor_tokens_actor ON actor_tokens(actor_id);

CREATE TABLE decision_grants (
  decision TEXT NOT NULL CHECK (
    decision IN (
      'APPROVE', 'DELIVER', 'COMPLETE', 'REJECT', 'CANCEL'
    )
  ),
  authoritative_status TEXT NOT NULL CHECK (
    authoritative_status IN (
      'APPROVED',
      'READY_FOR_DELIVERY',
      'JOB_COMPLETED',
      'REJECTED',
      'JOB_CANCELLED'
    )
  ),
  CHECK (
    (decision = 'APPROVE' AND authoritative_status = 'APPROVED')
    OR (decision = 'DELIVER' AND authoritative_status = 'READY_FOR_DELIVERY')
    OR (decision = 'COMPLETE' AND authoritative_status = 'JOB_COMPLETED')
    OR (decision = 'REJECT' AND authoritative_status = 'REJECTED')
    OR (decision = 'CANCEL' AND authoritative_status = 'JOB_CANCELLED')
  ),
  PRIMARY KEY (decision, authoritative_status)
);

CREATE TABLE authoritative_statuses (
  authoritative_status TEXT PRIMARY KEY NOT NULL CHECK (length(trim(authoritative_status)) > 0),
  rank INTEGER NOT NULL CHECK (rank >= 0),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1))
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(job_id)) > 0),
  workspace TEXT NOT NULL CHECK (length(trim(workspace)) > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  spec_json TEXT NOT NULL CHECK (length(trim(spec_json)) > 0),
  state TEXT NOT NULL CHECK (
    state IN (
      'CREATED',
      'IN_PROGRESS',
      'QA_RUNNING',
      'EVIDENCE_READY',
      'REPAIR',
      'PACKAGING',
      'STALLED',
      'APPROVED',
      'READY_FOR_DELIVERY',
      'JOB_COMPLETED',
      'REJECTED',
      'JOB_CANCELLED'
    )
  ),
  state_reason TEXT,
  authoritative_status TEXT REFERENCES authoritative_statuses(authoritative_status),
  deciding_decision_id TEXT REFERENCES decisions(decision_id),
  owner_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  cycle INTEGER NOT NULL DEFAULT 0 CHECK (cycle >= 0),
  max_cycles INTEGER NOT NULL CHECK (max_cycles >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deadline_at TEXT,
  stale_after_s INTEGER NOT NULL CHECK (stale_after_s >= 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);

CREATE INDEX ix_jobs_state_updated ON jobs(state, updated_at);
CREATE INDEX ix_jobs_workspace ON jobs(workspace, updated_at);
CREATE INDEX ix_jobs_auth_status ON jobs(authoritative_status);

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(decision_id)) > 0),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  cycle INTEGER NOT NULL CHECK (cycle >= 0),
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  session_token_id TEXT REFERENCES actor_tokens(token_id),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
  session_hint TEXT,
  decision TEXT NOT NULL CHECK (
    decision IN (
      'APPROVE',
      'FIX',
      'RETEST',
      'VERIFY_SELF',
      'IGNORE_FALSE_POSITIVE',
      'STOP',
      'REJECT',
      'PACKAGE',
      'DELIVER',
      'COMPLETE',
      'CANCEL'
    )
  ),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
  evidence_refs TEXT,
  from_state TEXT NOT NULL CHECK (length(trim(from_state)) > 0),
  to_state TEXT NOT NULL CHECK (length(trim(to_state)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE INDEX ix_decisions_job ON decisions(job_id, cycle);
CREATE INDEX ix_decisions_session ON decisions(session_token_id);

CREATE TABLE worker_runs (
  run_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(run_id)) > 0),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  cycle INTEGER NOT NULL CHECK (cycle >= 0),
  worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
  adapter TEXT NOT NULL CHECK (length(trim(adapter)) > 0),
  request_json TEXT NOT NULL CHECK (length(trim(request_json)) > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'TIMEOUT',
      'CANCELLED',
      'MALFORMED',
      'ORPHANED'
    )
  ),
  worker_verdict TEXT CHECK (
    worker_verdict IS NULL
    OR worker_verdict IN ('PASS', 'FAIL', 'INCONCLUSIVE', 'NONE')
  ),
  failure_class TEXT CHECK (
    failure_class IS NULL
    OR failure_class IN (
      'SPAWN_FAILED',
      'TRANSIENT',
      'AUTH_REQUIRED',
      'MALFORMED_OUTPUT',
      'TIMEOUT',
      'MODEL_ERROR'
    )
  ),
  exit_code INTEGER,
  pid INTEGER,
  usage_json TEXT,
  stderr_tail TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  UNIQUE (run_id, job_id, cycle)
);

CREATE INDEX ix_runs_job_cycle ON worker_runs(job_id, cycle, status);
CREATE UNIQUE INDEX ux_worker_runs_run_job_cycle
  ON worker_runs(run_id, job_id, cycle);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(evidence_id)) > 0),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  cycle INTEGER NOT NULL CHECK (cycle >= 0),
  run_id TEXT REFERENCES worker_runs(run_id),
  source_actor TEXT NOT NULL REFERENCES actors(actor_id),
  trust TEXT NOT NULL CHECK (trust IN ('deterministic', 'untrusted', 'principal')),
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  severity TEXT,
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0 AND length(summary) <= 2048),
  detail_json TEXT CHECK (detail_json IS NULL OR length(detail_json) <= 65536),
  artifact_id TEXT REFERENCES artifacts(artifact_id),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE INDEX ix_evidence_job_cycle ON evidence(job_id, cycle);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(artifact_id)) > 0),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  cycle INTEGER NOT NULL CHECK (cycle >= 0),
  run_id TEXT REFERENCES worker_runs(run_id),
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  mime TEXT,
  label TEXT,
  rel_path TEXT NOT NULL CHECK (length(trim(rel_path)) > 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL
    CHECK (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9A-Fa-f]*'
    ),
  created_by TEXT NOT NULL REFERENCES actors(actor_id),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  UNIQUE (job_id, rel_path)
);

CREATE UNIQUE INDEX ux_artifacts_job_rel_path ON artifacts(job_id, rel_path);

CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(lease_id)) > 0),
  run_id TEXT NOT NULL REFERENCES worker_runs(run_id),
  job_id TEXT NOT NULL CHECK (length(trim(job_id)) > 0),
  cycle INTEGER NOT NULL CHECK (cycle >= 0),
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  nonce TEXT NOT NULL CHECK (length(trim(nonce)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  consumed_at TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  FOREIGN KEY (run_id, job_id, cycle)
    REFERENCES worker_runs(run_id, job_id, cycle)
);

CREATE UNIQUE INDEX ux_leases_run_id ON leases(run_id);

CREATE TABLE idempotency (
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  key TEXT NOT NULL CHECK (
    length(key) = 36
    AND substr(key, 9, 1) = '-'
    AND substr(key, 14, 1) = '-'
    AND substr(key, 19, 1) = '-'
    AND substr(key, 24, 1) = '-'
    AND key NOT GLOB '*[^0-9A-Fa-f-]*'
  ),
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  response_json TEXT NOT NULL CHECK (length(trim(response_json)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  PRIMARY KEY (actor_id, key)
);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL CHECK (length(trim(ts)) > 0),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('principal', 'worker', 'observer', 'system')),
  session_token_id TEXT,
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
  session_hint TEXT,
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  job_id TEXT,
  cycle INTEGER CHECK (cycle IS NULL OR cycle >= 0),
  capability TEXT,
  subject_type TEXT,
  subject_id TEXT,
  from_state TEXT,
  to_state TEXT,
  from_auth_status TEXT,
  to_auth_status TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'error')),
  detail_json TEXT CHECK (detail_json IS NULL OR length(detail_json) <= 65536),
  prev_hash TEXT NOT NULL CHECK (length(trim(prev_hash)) > 0),
  hash TEXT NOT NULL CHECK (length(trim(hash)) > 0)
);

CREATE INDEX ix_audit_job ON audit_log(job_id, seq);
CREATE INDEX ix_audit_session ON audit_log(session_token_id, seq);
