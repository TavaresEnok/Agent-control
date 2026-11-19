ALTER TABLE ac_verify_runs ADD COLUMN performance_measurement jsonb
  CHECK (performance_measurement IS NULL OR
    (module = 'desempenho' AND status = 'done' AND collector_image IS NOT NULL
     AND jsonb_typeof(performance_measurement) = 'object'
     AND performance_measurement ? 'imageDigest'
     AND performance_measurement->'imageDigest' = to_jsonb(collector_image)
     AND octet_length(performance_measurement::text) <= 524288));
CREATE INDEX ac_verify_performance_history ON ac_verify_runs
  (project_id, context_id, collector_image, finished_at DESC, id DESC)
  WHERE performance_measurement IS NOT NULL;
