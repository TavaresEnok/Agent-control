CREATE TABLE ac_sandbox_jobs(id uuid PRIMARY KEY,context_id uuid NOT NULL REFERENCES ac_contexts,
 grant_id uuid NOT NULL UNIQUE REFERENCES ac_capacity_grants,manager_epoch bigint NOT NULL,
 profile text NOT NULL CHECK(profile IN ('synthetic-probe-v1')),spec_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('uncertain','running','completed','failed')),
 container_id text,receipt jsonb,created_at timestamptz NOT NULL DEFAULT now());
