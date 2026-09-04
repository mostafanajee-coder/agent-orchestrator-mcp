CREATE TABLE actors_v9 (
  actor_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(actor_id)) > 0),
  role TEXT NOT NULL CHECK (role IN ('principal', 'worker', 'observer', 'system', 'edge')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  capabilities_json TEXT NOT NULL CHECK (length(trim(capabilities_json)) > 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

INSERT INTO actors_v9(actor_id, role, display_name, capabilities_json, disabled, created_at)
SELECT actor_id, role, display_name, capabilities_json, disabled, created_at
FROM actors;

DROP TABLE actors;
ALTER TABLE actors_v9 RENAME TO actors;

CREATE UNIQUE INDEX ux_actors_single_principal
  ON actors(role)
  WHERE role = 'principal';

CREATE TRIGGER trg_actors_identity_immutable
BEFORE UPDATE ON actors
WHEN NEW.actor_id IS NOT OLD.actor_id
  OR NEW.role IS NOT OLD.role
  OR NEW.capabilities_json IS NOT OLD.capabilities_json
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'actor identity, role, capabilities, and creation time are immutable');
END;

CREATE TABLE audit_log_v9 (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL CHECK (length(trim(ts)) > 0),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('principal', 'worker', 'observer', 'system', 'edge')),
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

INSERT INTO audit_log_v9(
  seq, ts, actor_id, actor_role, session_token_id, request_id, session_hint,
  action, job_id, cycle, capability, subject_type, subject_id, from_state,
  to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash,
  hash
)
SELECT
  seq, ts, actor_id, actor_role, session_token_id, request_id, session_hint,
  action, job_id, cycle, capability, subject_type, subject_id, from_state,
  to_state, from_auth_status, to_auth_status, result, detail_json, prev_hash,
  hash
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v9 RENAME TO audit_log;

CREATE INDEX ix_audit_job ON audit_log(job_id, seq);
CREATE INDEX ix_audit_session ON audit_log(session_token_id, seq);

CREATE TRIGGER trg_audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER trg_audit_no_replace
BEFORE INSERT ON audit_log
WHEN NEW.seq > 0
  AND EXISTS (SELECT 1 FROM audit_log WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only and cannot be replaced');
END;

CREATE TABLE edge_transport_bindings (
  edge_actor_id TEXT PRIMARY KEY NOT NULL REFERENCES actors(actor_id),
  integration_id TEXT NOT NULL REFERENCES integrations(integration_id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);

CREATE UNIQUE INDEX ux_edge_transport_bindings_integration
  ON edge_transport_bindings(integration_id);

CREATE TRIGGER trg_edge_bindings_no_replace
BEFORE INSERT ON edge_transport_bindings
WHEN EXISTS (SELECT 1 FROM edge_transport_bindings WHERE edge_actor_id = NEW.edge_actor_id)
BEGIN
  SELECT RAISE(ABORT, 'edge transport bindings cannot be replaced');
END;

CREATE TRIGGER trg_edge_bindings_identity_immutable
BEFORE UPDATE ON edge_transport_bindings
WHEN NEW.edge_actor_id IS NOT OLD.edge_actor_id
  OR NEW.integration_id IS NOT OLD.integration_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'edge transport binding identity and creation time are immutable');
END;

CREATE TRIGGER trg_edge_bindings_no_delete
BEFORE DELETE ON edge_transport_bindings
BEGIN
  SELECT RAISE(ABORT, 'edge transport bindings cannot be deleted');
END;

CREATE TRIGGER trg_edge_bindings_actor_role
BEFORE INSERT ON edge_transport_bindings
BEGIN
  SELECT RAISE(ABORT, 'edge transport binding requires an edge actor')
  WHERE NOT EXISTS (
    SELECT 1 FROM actors
    WHERE actor_id = NEW.edge_actor_id
      AND role = 'edge'
  );
  SELECT RAISE(ABORT, 'edge transport binding requires an integration')
  WHERE NOT EXISTS (
    SELECT 1 FROM integrations
    WHERE integration_id = NEW.integration_id
  );
END;
