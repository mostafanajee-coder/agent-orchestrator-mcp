CREATE INDEX ix_evidence_job_cycle_created
  ON evidence(job_id, cycle, created_at, evidence_id);

CREATE INDEX ix_artifacts_job_cycle_created
  ON artifacts(job_id, cycle, created_at, artifact_id);

CREATE TRIGGER trg_evidence_no_update
BEFORE UPDATE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence rows are append-only');
END;

CREATE TRIGGER trg_evidence_no_delete
BEFORE DELETE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence rows are append-only');
END;

CREATE TRIGGER trg_evidence_no_replace
BEFORE INSERT ON evidence
WHEN EXISTS (SELECT 1 FROM evidence WHERE evidence_id = NEW.evidence_id)
BEGIN
  SELECT RAISE(ABORT, 'evidence identities cannot be replaced');
END;

CREATE TRIGGER trg_evidence_binding
BEFORE INSERT ON evidence
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM jobs
      WHERE job_id = NEW.job_id AND cycle = NEW.cycle
    ) THEN RAISE(ABORT, 'evidence job/cycle binding is invalid')
  END;
  SELECT CASE
    WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM worker_runs
      WHERE run_id = NEW.run_id AND job_id = NEW.job_id AND cycle = NEW.cycle
    ) THEN RAISE(ABORT, 'evidence run binding is invalid')
  END;
  SELECT CASE
    WHEN NEW.artifact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE artifact_id = NEW.artifact_id
        AND job_id = NEW.job_id
        AND cycle = NEW.cycle
        AND (NEW.run_id IS NULL OR run_id = NEW.run_id)
    ) THEN RAISE(ABORT, 'evidence artifact binding is invalid')
  END;
END;

CREATE TRIGGER trg_artifacts_no_update
BEFORE UPDATE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact rows are append-only');
END;

CREATE TRIGGER trg_artifacts_no_delete
BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact rows are append-only');
END;

CREATE TRIGGER trg_artifacts_no_replace
BEFORE INSERT ON artifacts
WHEN EXISTS (SELECT 1 FROM artifacts WHERE artifact_id = NEW.artifact_id)
BEGIN
  SELECT RAISE(ABORT, 'artifact identities cannot be replaced');
END;

CREATE TRIGGER trg_artifacts_binding
BEFORE INSERT ON artifacts
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM jobs
      WHERE job_id = NEW.job_id AND cycle = NEW.cycle
    ) THEN RAISE(ABORT, 'artifact job/cycle binding is invalid')
  END;
  SELECT CASE
    WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM worker_runs
      WHERE run_id = NEW.run_id AND job_id = NEW.job_id AND cycle = NEW.cycle
    ) THEN RAISE(ABORT, 'artifact run binding is invalid')
  END;
END;
