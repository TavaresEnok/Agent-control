ALTER TABLE ac_verify_coverage ADD COLUMN collector_measurements jsonb
  NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(collector_measurements) = 'array');
