ALTER TABLE ac_sandbox_jobs DROP CONSTRAINT ac_sandbox_jobs_profile_check;
ALTER TABLE ac_sandbox_jobs ADD CONSTRAINT ac_sandbox_jobs_profile_check
 CHECK(profile IN ('synthetic-probe-v1','synthetic-implementation-v1','synthetic-verification-v1'));
CREATE TABLE ac_stage_execution_launches(stage_id uuid PRIMARY KEY REFERENCES ac_stage_operations,
 context_id uuid NOT NULL REFERENCES ac_contexts,manager_epoch bigint NOT NULL,
 snapshot jsonb NOT NULL,digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER ac_stage_execution_launch_immutable BEFORE UPDATE OR DELETE ON ac_stage_execution_launches
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
