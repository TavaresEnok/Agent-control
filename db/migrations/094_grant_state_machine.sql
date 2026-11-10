-- Review hardening (2026-11-10). Validate the NOT VALID constraint left by 063 and
-- enforce the capacity-grant state machine in the database, not only in application code.
-- Fails the migration if any legacy row violates the writer-proof contract (intended).
ALTER TABLE ac_worktree_writers VALIDATE CONSTRAINT ac_worktree_writer_proof_v2;

CREATE FUNCTION ac_guard_capacity_grant_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CAPACITY_GRANT_IMMUTABLE'; END IF;
 IF OLD.state='released' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.physical_receipt IS DISTINCT FROM OLD.physical_receipt)
  THEN RAISE EXCEPTION 'GRANT_ALREADY_RELEASED'; END IF;
 IF NEW.state='reserved' AND OLD.state<>'reserved' THEN RAISE EXCEPTION 'INVALID_GRANT_TRANSITION'; END IF;
 IF ROW(NEW.id,NEW.attempt_id,NEW.intent_id,NEW.context_id,NEW.account_id,NEW.profile_id,NEW.role,NEW.project_id,NEW.request_digest)
  IS DISTINCT FROM ROW(OLD.id,OLD.attempt_id,OLD.intent_id,OLD.context_id,OLD.account_id,OLD.profile_id,OLD.role,OLD.project_id,OLD.request_digest)
  THEN RAISE EXCEPTION 'CAPACITY_GRANT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_capacity_grant_state_guard BEFORE UPDATE OR DELETE ON ac_capacity_grants
 FOR EACH ROW EXECUTE FUNCTION ac_guard_capacity_grant_state();
