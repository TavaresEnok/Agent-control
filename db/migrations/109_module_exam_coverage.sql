ALTER TABLE ac_verify_coverage DROP CONSTRAINT ac_verify_coverage_provenance_check;
ALTER TABLE ac_verify_coverage ADD CONSTRAINT ac_verify_coverage_provenance_check
  CHECK (provenance IN ('unknown', 'collector', 'examiner'));
