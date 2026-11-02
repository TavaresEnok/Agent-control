-- A local compositor consumes programmer capacity without impersonating a
-- provider account. Historical grants and waits remain model-backed.
ALTER TABLE ac_capacity_grants ADD COLUMN resource_kind text NOT NULL DEFAULT 'model';
ALTER TABLE ac_capacity_grants ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE ac_capacity_grants ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE ac_capacity_grants ADD CONSTRAINT ac_grant_resource_kind_check CHECK (
 (resource_kind='model' AND account_id IS NOT NULL AND profile_id IS NOT NULL) OR
 (resource_kind='local_compositor' AND role='programmer' AND account_id IS NULL AND profile_id IS NULL AND NOT emergency)
);
ALTER TABLE ac_capacity_waits ADD COLUMN resource_kind text NOT NULL DEFAULT 'model';
ALTER TABLE ac_capacity_waits ADD CONSTRAINT ac_wait_resource_kind_check CHECK (
 resource_kind='model' OR (resource_kind='local_compositor' AND role='programmer' AND desired_profile IS NULL)
);
CREATE INDEX ac_local_compositor_wait_order ON ac_capacity_waits(priority DESC,sequence) WHERE resource_kind='local_compositor';

-- A kind is never rebound after creation, and a local reservation must be the
-- exact immutable composition unit, including its operation and attempt.
CREATE FUNCTION ac_validate_local_compositor_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matched integer;
BEGIN
 IF TG_OP='UPDATE' AND NEW.resource_kind IS DISTINCT FROM OLD.resource_kind THEN
  RAISE EXCEPTION 'CAPACITY_RESOURCE_KIND_IMMUTABLE';
 END IF;
 IF NEW.resource_kind<>'local_compositor' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.intent_id IS DISTINCT FROM OLD.intent_id OR
    NEW.context_id IS DISTINCT FROM OLD.context_id OR NEW.role IS DISTINCT FROM OLD.role) THEN
  RAISE EXCEPTION 'LOCAL_COMPOSITOR_BINDING_IMMUTABLE';
 END IF;
 SELECT count(*) INTO matched FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id
 JOIN ac_managed_executions e ON e.parent_intent_id=i.parent_intent_id AND e.context_id=i.context_id
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.recipe->'units')='array' THEN e.recipe->'units' ELSE '[]'::jsonb END) u(value)
 WHERE i.id=NEW.intent_id AND i.context_id=NEW.context_id AND i.parent_intent_id IS NOT NULL
 AND o.id=i.operation_id AND o.execution_attempt_id=NEW.attempt_id
 AND u.value->>'id'=i.parent_unit_id AND u.value->>'kind'='composition' AND u.value->>'intentId'=i.id::text
 AND u.value->>'runId'=i.run_id::text AND u.value->>'operationId'=o.id::text AND u.value->>'attemptId'=NEW.attempt_id::text;
 IF matched<>1 THEN RAISE EXCEPTION 'LOCAL_COMPOSITOR_BINDING_INVALID'; END IF;
 IF TG_TABLE_NAME='ac_capacity_grants' THEN
  IF NEW.project_id IS DISTINCT FROM (SELECT project_id FROM ac_contexts WHERE id=NEW.context_id) THEN
   RAISE EXCEPTION 'LOCAL_COMPOSITOR_PROJECT_MISMATCH';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_local_compositor_grant_validate BEFORE INSERT OR UPDATE ON ac_capacity_grants
 FOR EACH ROW EXECUTE FUNCTION ac_validate_local_compositor_capacity();
CREATE TRIGGER ac_local_compositor_wait_validate BEFORE INSERT OR UPDATE ON ac_capacity_waits
 FOR EACH ROW EXECUTE FUNCTION ac_validate_local_compositor_capacity();
