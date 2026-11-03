CREATE TABLE ac_semantic_planning_calls (
 id uuid PRIMARY KEY, context_id uuid NOT NULL REFERENCES ac_contexts,
 intent_id uuid NOT NULL REFERENCES ac_intents, principal_id text NOT NULL,
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 executor_id text NOT NULL, executor_digest text NOT NULL CHECK(executor_digest ~ '^[a-f0-9]{64}$'),
 expected_revision integer NOT NULL CHECK(expected_revision>=0),
 attempt_id uuid NOT NULL UNIQUE, session_id uuid NOT NULL UNIQUE,
 grant_id uuid REFERENCES ac_capacity_grants, profile_id uuid REFERENCES ac_profiles,
 execution_epoch bigint CHECK(execution_epoch>0),
 state text NOT NULL CHECK(state IN ('registered','uncertain','ready','published','rejected')),
 proposal jsonb, receipt jsonb, result jsonb, failure_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX ac_semantic_single_manager_call ON ac_semantic_planning_calls(context_id)
 WHERE state IN ('registered','uncertain','ready');
CREATE FUNCTION ac_guard_semantic_planning_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.context_id,NEW.intent_id,NEW.principal_id,NEW.input_digest,NEW.executor_id,NEW.executor_digest,NEW.expected_revision,NEW.attempt_id,NEW.session_id)
 IS DISTINCT FROM ROW(OLD.id,OLD.context_id,OLD.intent_id,OLD.principal_id,OLD.input_digest,OLD.executor_id,OLD.executor_digest,OLD.expected_revision,OLD.attempt_id,OLD.session_id)
 OR (OLD.grant_id IS NOT NULL AND ROW(NEW.grant_id,NEW.profile_id,NEW.execution_epoch) IS DISTINCT FROM ROW(OLD.grant_id,OLD.profile_id,OLD.execution_epoch))
 OR (OLD.state IN ('published','rejected') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'SEMANTIC_PLANNING_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_semantic_planning_identity BEFORE UPDATE ON ac_semantic_planning_calls
 FOR EACH ROW EXECUTE FUNCTION ac_guard_semantic_planning_identity();
