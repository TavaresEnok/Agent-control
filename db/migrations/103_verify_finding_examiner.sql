-- Record the original examiner profile and account on each finding so recheck excludes the same examiner without guessing historical identity.
ALTER TABLE ac_verify_findings
  ADD COLUMN examiner_profile_id uuid,
  ADD COLUMN examiner_account_id uuid;
