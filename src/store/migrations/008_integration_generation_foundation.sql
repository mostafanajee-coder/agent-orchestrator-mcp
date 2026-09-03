CREATE TABLE integrations (
  integration_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(integration_id)) > 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);

CREATE TRIGGER trg_integrations_no_replace
BEFORE INSERT ON integrations
WHEN EXISTS (SELECT 1 FROM integrations WHERE integration_id = NEW.integration_id)
BEGIN
  SELECT RAISE(ABORT, 'integration identities cannot be replaced');
END;

CREATE TRIGGER trg_integrations_identity_immutable
BEFORE UPDATE ON integrations
WHEN NEW.integration_id IS NOT OLD.integration_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'integration identity and creation time are immutable');
END;

CREATE TRIGGER trg_integrations_generation_monotonic
BEFORE UPDATE OF generation ON integrations
WHEN NEW.generation < OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'integration generation cannot decrease');
END;
