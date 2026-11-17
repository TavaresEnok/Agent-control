-- Personal security verification. Rows point at a read-only intent.
-- The report itself lives under the installation data directory, mode 0700.
CREATE TABLE ac_verify_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES ac_projects,
  context_id uuid NOT NULL REFERENCES ac_contexts,
  intent_id uuid NOT NULL UNIQUE REFERENCES ac_intents,
  principal_id text NOT NULL,
  commit_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  report_dir text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);

CREATE TABLE ac_verify_findings (
  run_id uuid NOT NULL REFERENCES ac_verify_runs ON DELETE CASCADE,
  achado_id text NOT NULL CHECK (achado_id ~ '^ACH-[0-9]{3}$'),
  status text NOT NULL CHECK (status IN ('confirmado', 'provavel', 'descartado', 'fechado', 'reaberto')),
  severity text NOT NULL CHECK (severity IN ('alta', 'media', 'baixa', 'informativa')),
  file text NOT NULL,
  line integer,
  payload jsonb NOT NULL,
  PRIMARY KEY (run_id, achado_id)
);

CREATE TABLE ac_verify_coverage (
  run_id uuid NOT NULL REFERENCES ac_verify_runs ON DELETE CASCADE,
  file text NOT NULL,
  examiner_provider text NOT NULL,
  examiner_model text NOT NULL,
  profile_id uuid NOT NULL,
  checklist jsonb NOT NULL,
  PRIMARY KEY (run_id, file)
);

CREATE TABLE ac_verify_remediations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES ac_verify_runs,
  finding_ids text[] NOT NULL,
  message_local_id text NOT NULL,
  write_paths text[] NOT NULL,
  regression_test text NOT NULL,
  acceptance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
