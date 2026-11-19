-- Dedicated exam contexts, run binding and tool coverage for verification modules 2 to 9.
ALTER TABLE ac_exam_contexts
  DROP CONSTRAINT ac_exam_contexts_module_check,
  ADD CONSTRAINT ac_exam_contexts_module_check CHECK (
    module IN (
      'design',
      'verify',
      'qa',
      'arquitetura',
      'dependencias',
      'banco',
      'prontidao',
      'desempenho',
      'documentacao',
      'conformidade'
    )
  );

ALTER TABLE ac_verify_runs
  ADD COLUMN module text NOT NULL DEFAULT 'verify'
  CHECK (
    module IN (
      'verify',
      'qa',
      'arquitetura',
      'dependencias',
      'banco',
      'prontidao',
      'desempenho',
      'documentacao',
      'conformidade'
    )
  );

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
  IF NEW.module <> 'verify' AND NOT EXISTS (
    SELECT 1 FROM ac_exam_contexts e
    WHERE e.project_id = NEW.project_id
      AND e.module = NEW.module
      AND e.context_id = NEW.context_id
  ) THEN
    RAISE EXCEPTION 'VERIFY_RUN_EXAM_CONTEXT_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ac_verify_runs_context_guard
  BEFORE INSERT OR UPDATE ON ac_verify_runs
  FOR EACH ROW EXECUTE FUNCTION ac_check_verify_run_context();

CREATE TABLE ac_verify_tool_coverage (
  run_id uuid NOT NULL REFERENCES ac_verify_runs ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 1),
  tool text NOT NULL CHECK (btrim(tool) <> '' AND char_length(tool) <= 120),
  version text NOT NULL CHECK (btrim(version) <> '' AND char_length(version) <= 120),
  status text NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  detail text NOT NULL CHECK (btrim(detail) <> '' AND char_length(detail) <= 2000),
  PRIMARY KEY (run_id, seq)
);
