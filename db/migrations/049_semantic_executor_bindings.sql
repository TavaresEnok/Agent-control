-- Pin the selected provider adapter only when a grant is bound. Adding another
-- adapter must not invalidate an unrelated pending call or reroute an old job.
ALTER TABLE ac_semantic_planning_calls ADD COLUMN selected_executor_id text;
ALTER TABLE ac_semantic_planning_calls ADD COLUMN selected_executor_digest text;
ALTER TABLE ac_semantic_planning_calls ADD COLUMN selected_key_fingerprint text;
ALTER TABLE ac_semantic_planning_calls ADD CONSTRAINT ac_semantic_executor_binding_complete CHECK (
 (selected_executor_id IS NULL AND selected_executor_digest IS NULL AND selected_key_fingerprint IS NULL) OR
 (selected_executor_id IS NOT NULL AND selected_executor_digest ~ '^[a-f0-9]{64}$' AND selected_key_fingerprint ~ '^[a-f0-9]{64}$'));
CREATE OR REPLACE FUNCTION ac_guard_semantic_planning_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.context_id,NEW.intent_id,NEW.principal_id,NEW.input_digest,NEW.executor_id,NEW.executor_digest,NEW.expected_revision,NEW.attempt_id,NEW.session_id)
 IS DISTINCT FROM ROW(OLD.id,OLD.context_id,OLD.intent_id,OLD.principal_id,OLD.input_digest,OLD.executor_id,OLD.executor_digest,OLD.expected_revision,OLD.attempt_id,OLD.session_id)
 OR (OLD.grant_id IS NOT NULL AND ROW(NEW.grant_id,NEW.profile_id,NEW.execution_epoch) IS DISTINCT FROM ROW(OLD.grant_id,OLD.profile_id,OLD.execution_epoch))
 OR (OLD.selected_executor_id IS NOT NULL AND ROW(NEW.selected_executor_id,NEW.selected_executor_digest,NEW.selected_key_fingerprint)
 IS DISTINCT FROM ROW(OLD.selected_executor_id,OLD.selected_executor_digest,OLD.selected_key_fingerprint))
 OR (OLD.state IN ('published','rejected') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'SEMANTIC_PLANNING_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
