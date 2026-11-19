-- Automated collectors have no model profile. Preserve actual specialist profiles.
ALTER TABLE ac_verify_coverage ALTER COLUMN profile_id DROP NOT NULL;
UPDATE ac_verify_coverage c
SET profile_id = NULL, examiner_provider = 'ferramenta'
FROM ac_verify_runs r
WHERE r.id = c.run_id AND r.module <> 'verify'
  AND c.profile_id = '00000000-0000-4000-8000-000000000104'::uuid;
