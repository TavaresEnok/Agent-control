-- Registration is metadata, never authorization to enable a real account.
CREATE TABLE ac_readonly_quota_registrations (
 account_id uuid PRIMARY KEY REFERENCES ac_accounts(id),
 subject_digest text NOT NULL CHECK(subject_digest ~ '^[a-f0-9]{64}$'),
 configuration_digest text NOT NULL CHECK(configuration_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('configured-inactive','lab-synthetic')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
