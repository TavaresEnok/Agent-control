-- Supervisor journal only. No scheduler or automatic real-account activation.
CREATE TABLE ac_native_planning_jobs (
 id uuid PRIMARY KEY REFERENCES ac_semantic_planning_calls(id),
 grant_id uuid NOT NULL UNIQUE REFERENCES ac_capacity_grants(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 launch_digest text NOT NULL CHECK(launch_digest ~ '^[a-f0-9]{64}$'),
 container_name text NOT NULL UNIQUE,
 container_id text,
 state text NOT NULL CHECK(state IN ('prepared','uncertain','running','completed','failed')),
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(container_id IS NULL OR container_id ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION ac_guard_native_planning_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.grant_id,NEW.context_id,NEW.input_digest,NEW.launch_digest,NEW.container_name)
 IS DISTINCT FROM ROW(OLD.id,OLD.grant_id,OLD.context_id,OLD.input_digest,OLD.launch_digest,OLD.container_name)
 OR (OLD.container_id IS NOT NULL AND NEW.container_id IS DISTINCT FROM OLD.container_id)
 OR (OLD.state IN ('completed','failed') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'NATIVE_PLANNING_JOB_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_native_planning_job_guard BEFORE UPDATE ON ac_native_planning_jobs
 FOR EACH ROW EXECUTE FUNCTION ac_guard_native_planning_job();
