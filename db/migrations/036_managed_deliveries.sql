ALTER TABLE ac_intents ADD COLUMN parent_intent_id uuid REFERENCES ac_intents;
ALTER TABLE ac_intents ADD COLUMN parent_unit_id text;
ALTER TABLE ac_intents ADD CONSTRAINT ac_subdelivery_pair CHECK((parent_intent_id IS NULL)=(parent_unit_id IS NULL));
CREATE UNIQUE INDEX ac_subdelivery_identity ON ac_intents(parent_intent_id,parent_unit_id) WHERE parent_intent_id IS NOT NULL;
CREATE FUNCTION ac_reject_delivery_rebinding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.parent_intent_id IS DISTINCT FROM OLD.parent_intent_id OR NEW.parent_unit_id IS DISTINCT FROM OLD.parent_unit_id
 THEN RAISE EXCEPTION 'SUBDELIVERY_IDENTITY_IMMUTABLE'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER ac_subdelivery_immutable BEFORE UPDATE ON ac_intents FOR EACH ROW EXECUTE FUNCTION ac_reject_delivery_rebinding();
-- Serialize cancellation and child creation on the parent, then validate the
-- relationship at the database boundary as well as in the controller.
CREATE FUNCTION ac_validate_managed_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent ac_intents%ROWTYPE;
BEGIN
 IF NEW.parent_intent_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO parent FROM ac_intents WHERE id=NEW.parent_intent_id FOR UPDATE;
 IF NOT FOUND OR parent.context_id<>NEW.context_id OR parent.principal_id<>NEW.principal_id OR
    parent.plan_revision<>NEW.plan_revision OR parent.parent_intent_id IS NOT NULL THEN
  RAISE EXCEPTION 'SUBDELIVERY_PARENT_MISMATCH';
 END IF;
 IF EXISTS(SELECT 1 FROM ac_plan_cancellations WHERE intent_id=NEW.parent_intent_id) THEN
  RAISE EXCEPTION 'PLAN_CANCELLATION_REQUESTED';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_managed_child_validate BEFORE INSERT ON ac_intents FOR EACH ROW EXECUTE FUNCTION ac_validate_managed_child();
CREATE FUNCTION ac_lock_cancellation_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM 1 FROM ac_intents WHERE id=NEW.intent_id FOR UPDATE; RETURN NEW; END; $$;
CREATE TRIGGER ac_managed_cancel_lock BEFORE INSERT ON ac_plan_cancellations FOR EACH ROW EXECUTE FUNCTION ac_lock_cancellation_parent();
CREATE TABLE ac_managed_executions(parent_intent_id uuid PRIMARY KEY REFERENCES ac_intents,context_id uuid NOT NULL REFERENCES ac_contexts,
 proposal_revision integer NOT NULL,proposal_digest text NOT NULL,recipe_digest text NOT NULL,recipe jsonb NOT NULL,
 FOREIGN KEY(context_id,proposal_revision) REFERENCES ac_manager_plans(context_id,revision));
CREATE TRIGGER ac_managed_execution_immutable BEFORE UPDATE OR DELETE ON ac_managed_executions
 FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
CREATE TABLE ac_managed_delivery_inputs(intent_id uuid PRIMARY KEY REFERENCES ac_intents,base_id text NOT NULL,snapshot jsonb NOT NULL,digest text NOT NULL);
CREATE TRIGGER ac_managed_inputs_immutable BEFORE UPDATE OR DELETE ON ac_managed_delivery_inputs
 FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
CREATE TABLE ac_managed_composition_sources(intent_id uuid PRIMARY KEY REFERENCES ac_intents,
 snapshot jsonb NOT NULL,digest text NOT NULL);
CREATE TRIGGER ac_managed_sources_immutable BEFORE UPDATE OR DELETE ON ac_managed_composition_sources
 FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
CREATE FUNCTION ac_propagate_managed_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision)
 SELECT id,context_id,NEW.requested_by,plan_revision FROM ac_intents WHERE parent_intent_id=NEW.intent_id
 ON CONFLICT(intent_id) DO NOTHING; RETURN NEW; END; $$;
CREATE TRIGGER ac_managed_cancel AFTER INSERT ON ac_plan_cancellations
 FOR EACH ROW EXECUTE FUNCTION ac_propagate_managed_cancellation();
