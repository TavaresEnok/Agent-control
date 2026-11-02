ALTER TABLE ac_sandbox_jobs DROP CONSTRAINT ac_sandbox_jobs_profile_check;
ALTER TABLE ac_sandbox_jobs ADD CONSTRAINT ac_sandbox_jobs_profile_check
 CHECK(profile IN ('synthetic-probe-v1','synthetic-implementation-v1','synthetic-verification-v1','synthetic-specialist-v1'));
CREATE TABLE ac_specialist_advice (
 id uuid PRIMARY KEY,
 intent_id uuid NOT NULL UNIQUE REFERENCES ac_intents(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 unit_id text NOT NULL,
 operation_id uuid NOT NULL REFERENCES ac_operations(id),
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 base_id text NOT NULL CHECK(base_id ~ '^[a-f0-9]{40}$'),
 scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
 session_id uuid NOT NULL UNIQUE,
 attempt_id uuid NOT NULL UNIQUE,
 grant_id uuid REFERENCES ac_capacity_grants(id),
 manager_epoch bigint NOT NULL CHECK(manager_epoch>0),
 state text NOT NULL CHECK(state IN ('registered','uncertain','running','completed')),
 receipt jsonb,
 signature text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ac_specialist_advice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SPECIALIST_ADVICE_IMMUTABLE'; END IF;
 IF OLD.state='completed' OR NEW.id<>OLD.id OR NEW.intent_id<>OLD.intent_id OR NEW.context_id<>OLD.context_id OR
    NEW.unit_id<>OLD.unit_id OR NEW.operation_id<>OLD.operation_id OR NEW.policy_revision<>OLD.policy_revision OR
    NEW.base_id<>OLD.base_id OR NEW.scope_digest<>OLD.scope_digest OR NEW.input_digest<>OLD.input_digest OR
    NEW.policy_digest<>OLD.policy_digest OR NEW.session_id<>OLD.session_id OR NEW.attempt_id<>OLD.attempt_id THEN
  RAISE EXCEPTION 'SPECIALIST_ADVICE_IMMUTABLE';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_specialist_advice_immutable BEFORE UPDATE OR DELETE ON ac_specialist_advice
 FOR EACH ROW EXECUTE FUNCTION ac_specialist_advice_guard();
CREATE TABLE ac_specialist_execution_launches (
 advice_id uuid PRIMARY KEY REFERENCES ac_specialist_advice(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 manager_epoch bigint NOT NULL,
 snapshot jsonb NOT NULL,
 digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER ac_specialist_execution_launch_immutable BEFORE UPDATE OR DELETE ON ac_specialist_execution_launches
 FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
