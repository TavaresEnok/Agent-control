ALTER TABLE ac_sandbox_jobs DROP CONSTRAINT ac_sandbox_jobs_profile_check;
ALTER TABLE ac_sandbox_jobs ADD CONSTRAINT ac_sandbox_jobs_profile_check
 CHECK(profile IN ('synthetic-probe-v1','synthetic-implementation-v1'));
