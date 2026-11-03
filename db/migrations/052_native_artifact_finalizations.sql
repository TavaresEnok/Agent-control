CREATE TABLE ac_native_artifact_finalizations (
 job_id uuid PRIMARY KEY REFERENCES ac_native_execution_jobs,
 context_id uuid NOT NULL REFERENCES ac_contexts,
 manager_epoch bigint NOT NULL CHECK(manager_epoch>0),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
 base_id text NOT NULL CHECK(base_id ~ '^[a-f0-9]{40}$'),
 state text NOT NULL CHECK(state IN ('uncertain','running','ready','failed')),
 process_handle jsonb,
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ac_guard_native_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.job_id,NEW.context_id,NEW.manager_epoch,NEW.input_digest,NEW.scope_digest,NEW.base_id)
 IS DISTINCT FROM ROW(OLD.job_id,OLD.context_id,OLD.manager_epoch,OLD.input_digest,OLD.scope_digest,OLD.base_id)
 OR (OLD.process_handle IS NOT NULL AND NEW.process_handle IS DISTINCT FROM OLD.process_handle)
 OR (OLD.state IN ('ready','failed') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'NATIVE_FINALIZATION_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_native_finalization_guard BEFORE UPDATE ON ac_native_artifact_finalizations
 FOR EACH ROW EXECUTE FUNCTION ac_guard_native_finalization();
