CREATE TRIGGER trg_jobs_unstamped_on_insert
BEFORE INSERT ON jobs
WHEN NEW.authoritative_status IS NOT NULL
  OR NEW.deciding_decision_id IS NOT NULL
  OR NEW.state IN (
    'APPROVED',
    'READY_FOR_DELIVERY',
    'JOB_COMPLETED',
    'REJECTED',
    'JOB_CANCELLED'
  )
BEGIN
  SELECT RAISE(ABORT, 'jobs must begin without authoritative state');
END;

CREATE TRIGGER trg_jobs_no_delete
BEFORE DELETE ON jobs
BEGIN
  SELECT RAISE(ABORT, 'jobs are durable and cannot be deleted');
END;
