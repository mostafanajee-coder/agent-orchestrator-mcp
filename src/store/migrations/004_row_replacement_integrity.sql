CREATE TRIGGER trg_jobs_no_replace
BEFORE INSERT ON jobs
WHEN EXISTS (SELECT 1 FROM jobs WHERE job_id = NEW.job_id)
BEGIN
  SELECT RAISE(ABORT, 'jobs are durable and cannot be replaced');
END;

CREATE TRIGGER trg_decisions_no_replace
BEFORE INSERT ON decisions
WHEN EXISTS (SELECT 1 FROM decisions WHERE decision_id = NEW.decision_id)
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only and cannot be replaced');
END;

CREATE TRIGGER trg_audit_no_replace
BEFORE INSERT ON audit_log
WHEN NEW.seq IS NOT NULL
  AND EXISTS (SELECT 1 FROM audit_log WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only and cannot be replaced');
END;
