-- A separate journal: physical retirement never represents a verification verdict.
CREATE TABLE ac_native_terminal_retirements (
 job_id uuid PRIMARY KEY REFERENCES ac_native_execution_jobs(id),
 binding jsonb NOT NULL, state text NOT NULL CHECK(state IN ('prepared','removed')), proof jsonb,
 CHECK ((state='prepared' AND proof IS NULL) OR (state='removed' AND proof IS NOT NULL))
);
CREATE FUNCTION ac_guard_native_terminal_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NATIVE_TERMINAL_RETIREMENT_IMMUTABLE'; END IF;
 IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.binding IS DISTINCT FROM OLD.binding OR
    OLD.state <> 'prepared' OR NEW.state <> 'removed' THEN
  RAISE EXCEPTION 'NATIVE_TERMINAL_RETIREMENT_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_native_terminal_retirement_guard BEFORE UPDATE OR DELETE ON ac_native_terminal_retirements
 FOR EACH ROW EXECUTE FUNCTION ac_guard_native_terminal_retirement();
