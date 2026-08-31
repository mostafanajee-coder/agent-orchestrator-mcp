INSERT INTO decision_grants (decision, authoritative_status) VALUES
  ('APPROVE', 'APPROVED'),
  ('DELIVER', 'READY_FOR_DELIVERY'),
  ('COMPLETE', 'JOB_COMPLETED'),
  ('REJECT', 'REJECTED'),
  ('CANCEL', 'JOB_CANCELLED');

INSERT INTO authoritative_statuses (authoritative_status, rank, terminal) VALUES
  ('APPROVED', 10, 0),
  ('READY_FOR_DELIVERY', 20, 0),
  ('JOB_COMPLETED', 30, 1),
  ('REJECTED', 90, 1),
  ('JOB_CANCELLED', 91, 1);

CREATE TRIGGER trg_decisions_principal_only
BEFORE INSERT ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions require an enabled principal actor')
  WHERE NOT EXISTS (
    SELECT 1
    FROM actors a
    WHERE a.actor_id = NEW.actor_id
      AND a.role = 'principal'
      AND a.disabled = 0
  );
END;

CREATE TRIGGER trg_auth_status_requires_granting_decision
BEFORE UPDATE OF authoritative_status ON jobs
WHEN NEW.authoritative_status IS NOT OLD.authoritative_status
BEGIN
  SELECT RAISE(ABORT, 'authoritative_status requires a granting principal decision')
  WHERE NEW.authoritative_status IS NULL
     OR NEW.deciding_decision_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM decisions d
       JOIN actors a ON a.actor_id = d.actor_id
       JOIN decision_grants g ON g.decision = d.decision
       WHERE d.decision_id = NEW.deciding_decision_id
         AND d.job_id = NEW.job_id
         AND d.cycle = NEW.cycle
         AND d.to_state = NEW.state
         AND a.role = 'principal'
         AND a.disabled = 0
         AND g.authoritative_status = NEW.authoritative_status
     );
END;

CREATE TRIGGER trg_auth_status_monotonic
BEFORE UPDATE OF authoritative_status ON jobs
WHEN OLD.authoritative_status IS NOT NULL
 AND NEW.authoritative_status IS NOT OLD.authoritative_status
BEGIN
  SELECT RAISE(ABORT, 'authoritative_status is terminal or would regress')
  WHERE (SELECT terminal
         FROM authoritative_statuses
         WHERE authoritative_status = OLD.authoritative_status) = 1
     OR (SELECT rank
         FROM authoritative_statuses
         WHERE authoritative_status = NEW.authoritative_status)
        <= (SELECT rank
            FROM authoritative_statuses
            WHERE authoritative_status = OLD.authoritative_status);
END;

CREATE TRIGGER trg_state_matches_auth_status
BEFORE UPDATE OF state ON jobs
WHEN NEW.state IN (
  'APPROVED',
  'READY_FOR_DELIVERY',
  'JOB_COMPLETED',
  'REJECTED',
  'JOB_CANCELLED'
)
BEGIN
  SELECT RAISE(ABORT, 'authoritative state requires the matching authoritative_status')
  WHERE NEW.authoritative_status IS NOT NEW.state;
END;

CREATE TRIGGER trg_decisions_no_update
BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only');
END;

CREATE TRIGGER trg_decisions_no_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only');
END;

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

CREATE TRIGGER trg_grants_frozen_i
BEFORE INSERT ON decision_grants
BEGIN
  SELECT RAISE(ABORT, 'decision_grants is immutable');
END;

CREATE TRIGGER trg_grants_frozen_u
BEFORE UPDATE ON decision_grants
BEGIN
  SELECT RAISE(ABORT, 'decision_grants is immutable');
END;

CREATE TRIGGER trg_grants_frozen_d
BEFORE DELETE ON decision_grants
BEGIN
  SELECT RAISE(ABORT, 'decision_grants is immutable');
END;

CREATE TRIGGER trg_auth_statuses_frozen_i
BEFORE INSERT ON authoritative_statuses
BEGIN
  SELECT RAISE(ABORT, 'authoritative_statuses is immutable');
END;

CREATE TRIGGER trg_auth_statuses_frozen_u
BEFORE UPDATE ON authoritative_statuses
BEGIN
  SELECT RAISE(ABORT, 'authoritative_statuses is immutable');
END;

CREATE TRIGGER trg_auth_statuses_frozen_d
BEFORE DELETE ON authoritative_statuses
BEGIN
  SELECT RAISE(ABORT, 'authoritative_statuses is immutable');
END;
