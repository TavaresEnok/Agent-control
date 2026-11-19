-- Legacy verification runs may use an ordinary project context.  A dedicated
-- exam context, however, may only be used by its own module, including verify.
-- Keep the default for older verification clients that omit the module column.
ALTER TABLE ac_verify_runs ADD COLUMN collector_image text;

CREATE OR REPLACE FUNCTION ac_check_verify_run_context() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ac_contexts x
    WHERE x.id = NEW.context_id AND x.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'VERIFY_RUN_CONTEXT_PROJECT_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ac_intents i
    WHERE i.id = NEW.intent_id AND i.context_id = NEW.context_id
  ) THEN
    RAISE EXCEPTION 'VERIFY_RUN_INTENT_CONTEXT_MISMATCH';
  END IF;
  IF (NEW.module <> 'verify' AND NOT EXISTS (
    SELECT 1 FROM ac_exam_contexts e
    WHERE e.project_id = NEW.project_id
      AND e.module = NEW.module
      AND e.context_id = NEW.context_id
  )) OR (NEW.module = 'verify' AND EXISTS (
    SELECT 1 FROM ac_exam_contexts e
    WHERE e.context_id = NEW.context_id
      AND (e.project_id <> NEW.project_id OR e.module <> 'verify')
  )) THEN
    RAISE EXCEPTION 'VERIFY_RUN_EXAM_CONTEXT_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
