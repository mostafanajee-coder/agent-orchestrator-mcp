DROP TRIGGER trg_audit_no_replace;

CREATE TRIGGER trg_audit_no_replace
BEFORE INSERT ON audit_log
WHEN NEW.seq > 0
  AND EXISTS (SELECT 1 FROM audit_log WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only and cannot be replaced');
END;
