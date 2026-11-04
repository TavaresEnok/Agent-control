-- Native successful managed writers retain their job directory and both logs.
CREATE TABLE ac_native_writer_retirements(
 job_id uuid PRIMARY KEY REFERENCES ac_native_execution_jobs(id),
 parent_intent_id uuid NOT NULL,
 run_id uuid NOT NULL,
 holder_intent_id uuid NOT NULL,
 writer_epoch bigint NOT NULL CHECK(writer_epoch>0),
 worker_id text NOT NULL CHECK(worker_id ~ '^[a-f0-9]{64}$'),
 tools_id text NOT NULL CHECK(tools_id ~ '^[a-f0-9]{64}$' AND tools_id<>worker_id),
 terminal_digest text NOT NULL CHECK(terminal_digest ~ '^[a-f0-9]{64}$'),
 worker_log_sha256 text NOT NULL CHECK(worker_log_sha256 ~ '^[a-f0-9]{64}$'),
 tools_log_sha256 text NOT NULL CHECK(tools_log_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('prepared','revoked')),
 proof jsonb,
 FOREIGN KEY(parent_intent_id,run_id) REFERENCES ac_worktree_writers(parent_intent_id,run_id),
 CHECK((state='prepared' AND proof IS NULL) OR (state='revoked' AND proof IS NOT NULL AND jsonb_typeof(proof)='object')));
CREATE FUNCTION ac_guard_native_writer_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NATIVE_WRITER_RETIREMENT_IMMUTABLE'; END IF;
 IF ROW(NEW.job_id,NEW.parent_intent_id,NEW.run_id,NEW.holder_intent_id,NEW.writer_epoch,NEW.worker_id,NEW.tools_id,NEW.terminal_digest,NEW.worker_log_sha256,NEW.tools_log_sha256)
  IS DISTINCT FROM ROW(OLD.job_id,OLD.parent_intent_id,OLD.run_id,OLD.holder_intent_id,OLD.writer_epoch,OLD.worker_id,OLD.tools_id,OLD.terminal_digest,OLD.worker_log_sha256,OLD.tools_log_sha256)
  OR OLD.state<>'prepared' OR NEW.state<>'revoked' THEN RAISE EXCEPTION 'NATIVE_WRITER_RETIREMENT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_native_writer_retirement_immutable BEFORE UPDATE OR DELETE ON ac_native_writer_retirements
 FOR EACH ROW EXECUTE FUNCTION ac_guard_native_writer_retirement();
