-- A later recheck supersedes any in-flight recheck of the same run.
ALTER TABLE ac_verify_runs ADD COLUMN recheck_generation bigint NOT NULL DEFAULT 0;

-- The old migration replaced a synthetic profile for historical rows; it did
-- not preserve enough evidence to infer how each file was selected.
ALTER TABLE ac_verify_coverage ADD COLUMN provenance text NOT NULL DEFAULT 'unknown'
  CHECK (provenance IN ('unknown', 'collector'));
