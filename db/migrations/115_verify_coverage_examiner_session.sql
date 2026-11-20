-- The examiner's native execution per file. A recheck of a high examiner finding
-- compares it with the reviewer's execution. Older rows stay NULL and fail closed.
ALTER TABLE ac_verify_coverage ADD COLUMN examiner_grant_id uuid;
ALTER TABLE ac_verify_coverage ADD COLUMN examiner_session_id uuid;
ALTER TABLE ac_verify_coverage ADD CONSTRAINT ac_verify_coverage_examiner_session_pair
  CHECK ((examiner_grant_id IS NULL) = (examiner_session_id IS NULL)
    AND (examiner_grant_id IS NULL OR provenance = 'examiner'));
