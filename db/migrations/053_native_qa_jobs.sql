CREATE TABLE ac_native_qa_jobs (
 id uuid PRIMARY KEY REFERENCES ac_stage_operations,
 context_id uuid NOT NULL REFERENCES ac_contexts,
 intent_id uuid NOT NULL REFERENCES ac_intents,
 artifact_id uuid NOT NULL REFERENCES ac_artifacts,
 grant_id uuid NOT NULL UNIQUE REFERENCES ac_capacity_grants,
 session_id uuid NOT NULL UNIQUE,
 manager_epoch bigint NOT NULL CHECK(manager_epoch>0),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 contract_digest text NOT NULL CHECK(contract_digest ~ '^[a-f0-9]{64}$'),
 container_id text,
 state text NOT NULL CHECK(state IN ('uncertain','running','completed','failed')),
 deadline_at timestamptz NOT NULL,
 stop_reason text CHECK(stop_reason IN ('canceled','timeout')),
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(container_id IS NULL OR container_id ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION ac_guard_native_qa_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.context_id,NEW.intent_id,NEW.artifact_id,NEW.grant_id,NEW.session_id,NEW.manager_epoch,NEW.request_digest,NEW.contract_digest,NEW.deadline_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.context_id,OLD.intent_id,OLD.artifact_id,OLD.grant_id,OLD.session_id,OLD.manager_epoch,OLD.request_digest,OLD.contract_digest,OLD.deadline_at)
 OR (OLD.container_id IS NOT NULL AND NEW.container_id IS DISTINCT FROM OLD.container_id)
 OR (OLD.stop_reason IS NOT NULL AND NEW.stop_reason IS DISTINCT FROM OLD.stop_reason)
 OR (OLD.state IN ('completed','failed') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'NATIVE_QA_JOB_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_native_qa_job_guard BEFORE UPDATE ON ac_native_qa_jobs
 FOR EACH ROW EXECUTE FUNCTION ac_guard_native_qa_job();
