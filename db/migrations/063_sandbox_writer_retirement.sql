-- Lab-only journal. A prepared row never by itself releases a copy.
ALTER TABLE ac_worktree_writers DROP CONSTRAINT ac_worktree_writer_proof;
ALTER TABLE ac_worktree_writers ADD COLUMN revocation_job_id uuid,
 ADD COLUMN revocation_proof jsonb,
 ADD CONSTRAINT ac_worktree_writer_proof_v2 CHECK (
  (state='held' AND proof_digest IS NULL AND sealed_mode IS NULL AND revocation_job_id IS NULL AND revocation_proof IS NULL) OR
  (state='neutralized' AND proof_digest IS NOT NULL AND proof_digest ~ '^[a-f0-9]{64}$' AND sealed_mode IS NULL AND
   revocation_job_id IS NOT NULL AND revocation_proof IS NOT NULL AND jsonb_typeof(revocation_proof)='object')) NOT VALID;
CREATE TABLE ac_sandbox_writer_retirements(
 job_id uuid PRIMARY KEY REFERENCES ac_sandbox_jobs(id),
 parent_intent_id uuid NOT NULL,
 run_id uuid NOT NULL,
 holder_intent_id uuid NOT NULL,
 writer_epoch bigint NOT NULL CHECK(writer_epoch>0),
 container_id text NOT NULL CHECK(container_id ~ '^[a-f0-9]{64}$'),
 terminal_digest text NOT NULL CHECK(terminal_digest ~ '^[a-f0-9]{64}$'),
 log_sha256 text NOT NULL CHECK(log_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('prepared','revoked')),
 proof jsonb,
 FOREIGN KEY(parent_intent_id,run_id) REFERENCES ac_worktree_writers(parent_intent_id,run_id),
 CHECK((state='prepared' AND proof IS NULL) OR (state='revoked' AND proof IS NOT NULL AND jsonb_typeof(proof)='object')));

CREATE FUNCTION ac_guard_writer_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WORKTREE_RETIREMENT_IMMUTABLE'; END IF;
 IF ROW(NEW.job_id,NEW.parent_intent_id,NEW.run_id,NEW.holder_intent_id,NEW.writer_epoch,NEW.container_id,NEW.terminal_digest,NEW.log_sha256)
  IS DISTINCT FROM ROW(OLD.job_id,OLD.parent_intent_id,OLD.run_id,OLD.holder_intent_id,OLD.writer_epoch,OLD.container_id,OLD.terminal_digest,OLD.log_sha256)
  OR OLD.state<>'prepared' OR NEW.state<>'revoked' THEN RAISE EXCEPTION 'WORKTREE_RETIREMENT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_writer_retirement_immutable BEFORE UPDATE OR DELETE ON ac_sandbox_writer_retirements
 FOR EACH ROW EXECUTE FUNCTION ac_guard_writer_retirement();

CREATE FUNCTION ac_guard_worktree_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WORKTREE_WRITER_IMMUTABLE'; END IF;
 IF ROW(NEW.parent_intent_id,NEW.run_id,NEW.holder_intent_id,NEW.manager_epoch)
  IS DISTINCT FROM ROW(OLD.parent_intent_id,OLD.run_id,OLD.holder_intent_id,OLD.manager_epoch)
  OR (OLD.state='neutralized' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'WORKTREE_WRITER_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_worktree_identity_immutable BEFORE UPDATE OR DELETE ON ac_worktree_writers
 FOR EACH ROW EXECUTE FUNCTION ac_guard_worktree_identity();
