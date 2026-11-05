-- Durable quarantine precedes physical launch; no account mode/activation changes.
CREATE TABLE ac_readonly_quota_runs (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES ac_accounts(id),
 resource_name text NOT NULL UNIQUE, resource_id text,
 subject_digest text NOT NULL CHECK(subject_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('uncertain','stopped')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), stopped_at timestamptz,
 CHECK((state='stopped')=(stopped_at IS NOT NULL))
);
CREATE UNIQUE INDEX ac_readonly_quota_one_active ON ac_readonly_quota_runs(account_id) WHERE state='uncertain';
