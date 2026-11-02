-- User-supplied eligibility metadata is distinct from runtime activation and
-- from observed quota. Rows are append-only and never authorize execution.
CREATE TABLE ac_provider_eligibility_assessments (
 account_id uuid NOT NULL REFERENCES ac_accounts(id), revision integer NOT NULL CHECK(revision>0),
 project_id uuid NOT NULL REFERENCES ac_projects(id), principal_id text NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'), request_snapshot jsonb NOT NULL,
 provider text NOT NULL, account_mode text NOT NULL CHECK(account_mode IN ('synthetic','subscription_cli','api')),
 plan text NOT NULL, adapter_id text NOT NULL, adapter_version text NOT NULL,
 authentication_mode text NOT NULL, execution_mode text NOT NULL,
 source_url text NOT NULL CHECK(source_url ~ '^https://'),
 status text NOT NULL CHECK(status IN ('documented_supported','requires_clarification','unsupported_for_mode','not_assessed')),
 reason text NOT NULL, reviewed_at timestamptz NOT NULL, valid_for_seconds integer NOT NULL CHECK(valid_for_seconds BETWEEN 1 AND 31536000),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,revision),
 CHECK(expires_at=reviewed_at+valid_for_seconds*interval '1 second'),
 CHECK((account_mode='synthetic' AND authentication_mode='synthetic' AND execution_mode='synthetic') OR
       (account_mode='subscription_cli' AND authentication_mode='subscription_oauth' AND execution_mode='central_isolated_cli') OR
       (account_mode='api' AND authentication_mode='api_key' AND execution_mode='api'))
);
CREATE TRIGGER ac_provider_eligibility_immutable BEFORE UPDATE OR DELETE ON ac_provider_eligibility_assessments
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
