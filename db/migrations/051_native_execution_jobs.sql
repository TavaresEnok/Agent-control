-- Durable supervisor journal. No scheduler, provider activation or automatic retry.
CREATE TABLE ac_native_execution_jobs (
 id uuid PRIMARY KEY,
 grant_id uuid NOT NULL UNIQUE REFERENCES ac_capacity_grants,
 intent_id uuid NOT NULL REFERENCES ac_intents,
 context_id uuid NOT NULL REFERENCES ac_contexts,
 manager_epoch bigint NOT NULL CHECK(manager_epoch>0),
 session_id uuid NOT NULL UNIQUE,
 account_id uuid NOT NULL REFERENCES ac_accounts,
 profile_id uuid NOT NULL REFERENCES ac_profiles,
 profile_digest text NOT NULL CHECK(profile_digest ~ '^[a-f0-9]{64}$'),
 eligibility_revision integer NOT NULL CHECK(eligibility_revision>0),
 executor_digest text NOT NULL CHECK(executor_digest ~ '^[a-f0-9]{64}$'),
 key_fingerprint text NOT NULL CHECK(key_fingerprint ~ '^[a-f0-9]{64}$'),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 base_id text NOT NULL CHECK(base_id ~ '^[a-f0-9]{40}$'),
 role text NOT NULL CHECK(role IN ('programmer','qa','reviewer','judge','specialist')),
 state text NOT NULL CHECK(state IN ('uncertain','running','completed','failed')),
 network_id text,
 worker_id text,
 tools_id text,
 launch_digest text,
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(network_id IS NULL OR network_id ~ '^[a-f0-9]{64}$'),
 CHECK(worker_id IS NULL OR worker_id ~ '^[a-f0-9]{64}$'),
 CHECK(tools_id IS NULL OR tools_id ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION ac_guard_native_execution_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.grant_id,NEW.intent_id,NEW.context_id,NEW.manager_epoch,NEW.session_id,NEW.account_id,NEW.profile_id,NEW.profile_digest,NEW.eligibility_revision,NEW.executor_digest,NEW.key_fingerprint,NEW.input_digest,NEW.base_id,NEW.role)
 IS DISTINCT FROM ROW(OLD.id,OLD.grant_id,OLD.intent_id,OLD.context_id,OLD.manager_epoch,OLD.session_id,OLD.account_id,OLD.profile_id,OLD.profile_digest,OLD.eligibility_revision,OLD.executor_digest,OLD.key_fingerprint,OLD.input_digest,OLD.base_id,OLD.role)
 OR (OLD.network_id IS NOT NULL AND NEW.network_id IS DISTINCT FROM OLD.network_id)
 OR (OLD.worker_id IS NOT NULL AND NEW.worker_id IS DISTINCT FROM OLD.worker_id)
 OR (OLD.tools_id IS NOT NULL AND NEW.tools_id IS DISTINCT FROM OLD.tools_id)
 OR (OLD.launch_digest IS NOT NULL AND NEW.launch_digest IS DISTINCT FROM OLD.launch_digest)
 OR (OLD.state IN ('completed','failed') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'NATIVE_EXECUTION_JOB_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_native_execution_job_guard BEFORE UPDATE ON ac_native_execution_jobs
 FOR EACH ROW EXECUTE FUNCTION ac_guard_native_execution_job();
