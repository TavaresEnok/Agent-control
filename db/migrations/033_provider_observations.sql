-- Trusted collector configuration is separate from user model/profile labels.
-- No credentials or raw provider output are persisted here.
CREATE TABLE ac_provider_bindings (
 account_id uuid PRIMARY KEY REFERENCES ac_accounts(id), adapter_id text NOT NULL,
 adapter_version text NOT NULL, adapter_digest text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 minimum_interval_seconds integer NOT NULL CHECK(minimum_interval_seconds BETWEEN 1 AND 3600),
 lease_id uuid, lease_until timestamptz, last_started_at timestamptz,
 probe_uncertain boolean NOT NULL DEFAULT false,
 CHECK((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE TABLE ac_provider_observations (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES ac_accounts(id),
 adapter_digest text NOT NULL, binding_revision integer NOT NULL,
 state text NOT NULL CHECK(state IN ('collecting','completed','superseded')),
 lease_id uuid NOT NULL, started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz, expires_at timestamptz,
 snapshot jsonb, digest text,
 CHECK((state='completed')=(snapshot IS NOT NULL)),
 CHECK((snapshot IS NULL)=(digest IS NULL))
);
CREATE INDEX ac_provider_observations_account ON ac_provider_observations(account_id,started_at DESC);
