CREATE TABLE ac_native_qa_retirements (
 job_id uuid PRIMARY KEY REFERENCES ac_native_qa_jobs(id),
 identity jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','removed')),
 proof jsonb,
 CHECK ((state='prepared' AND proof IS NULL) OR (state='removed' AND jsonb_typeof(proof)='object'))
);
CREATE FUNCTION ac_guard_native_qa_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.job_id<>OLD.job_id OR NEW.identity IS DISTINCT FROM OLD.identity OR OLD.state<>'prepared' OR NEW.state<>'removed'
 THEN RAISE EXCEPTION 'NATIVE_QA_RETIREMENT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_native_qa_retirement_immutable BEFORE UPDATE OR DELETE ON ac_native_qa_retirements FOR EACH ROW EXECUTE FUNCTION ac_guard_native_qa_retirement();
