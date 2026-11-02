ALTER TABLE ac_remote_operations ADD COLUMN intent_id uuid REFERENCES ac_intents;
CREATE INDEX ac_remote_intent ON ac_remote_operations(intent_id);
-- Historical rows remain reconcilable without inventing their plan identity.
-- Every new dispatch must bind an existing intent in the same context.
CREATE FUNCTION ac_validate_remote_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.intent_id IS NULL THEN
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'REMOTE_INTENT_REQUIRED'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM ac_intents WHERE id=NEW.intent_id AND context_id=NEW.context_id) THEN
  RAISE EXCEPTION 'REMOTE_INTENT_SCOPE_MISMATCH';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.context_id IS DISTINCT FROM OLD.context_id) THEN
  RAISE EXCEPTION 'REMOTE_INTENT_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_remote_intent_binding BEFORE INSERT OR UPDATE OF intent_id,context_id ON ac_remote_operations
FOR EACH ROW EXECUTE FUNCTION ac_validate_remote_intent();
