-- A reserved report path is durable before the first write. A NULL reservation
-- identifies historical runs which predate durable publication and discard.
ALTER TABLE ac_verify_runs
  ADD COLUMN report_prepared_dir text,
  ADD COLUMN report_legacy_missing boolean NOT NULL DEFAULT false,
  ADD COLUMN collector_container_token uuid UNIQUE,
  ADD COLUMN collector_container_id text,
  ADD CONSTRAINT ac_verify_container_identity CHECK (
    collector_container_id IS NULL OR
    (collector_container_token IS NOT NULL AND collector_container_id ~ '^[a-f0-9]{64}$')
  );
