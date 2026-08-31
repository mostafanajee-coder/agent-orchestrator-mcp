CREATE TRIGGER trg_actors_identity_immutable
BEFORE UPDATE ON actors
WHEN NEW.actor_id IS NOT OLD.actor_id
  OR NEW.role IS NOT OLD.role
  OR NEW.capabilities_json IS NOT OLD.capabilities_json
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'actor identity, role, capabilities, and creation time are immutable');
END;

CREATE TRIGGER trg_actor_tokens_binding_immutable
BEFORE UPDATE ON actor_tokens
WHEN NEW.token_id IS NOT OLD.token_id
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.token_sha256 IS NOT OLD.token_sha256
  OR NEW.label IS NOT OLD.label
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'actor token identity, binding, label, expiry, and creation time are immutable');
END;

CREATE TRIGGER trg_actor_tokens_no_reenable
BEFORE UPDATE OF disabled ON actor_tokens
WHEN OLD.disabled = 1 AND NEW.disabled = 0
BEGIN
  SELECT RAISE(ABORT, 'disabled actor tokens cannot be re-enabled');
END;
