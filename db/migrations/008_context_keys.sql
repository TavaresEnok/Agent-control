-- Only fingerprints and metadata. Neither E2EE material nor its plaintext enters PG.
CREATE TABLE ac_context_keys(context_id uuid NOT NULL REFERENCES ac_contexts, version integer NOT NULL CHECK(version>0),
 variant text NOT NULL CHECK(variant IN ('legacy','dataKey')), fingerprint text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','revoked')), authorized_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(context_id,version));
CREATE UNIQUE INDEX ac_single_active_context_key ON ac_context_keys(context_id) WHERE state='active';
