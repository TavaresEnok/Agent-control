-- Immutable receipt/provenance for the independently signed remote return effect.
CREATE TABLE ac_remote_artifact_returns (
 id uuid PRIMARY KEY REFERENCES ac_project_admin_intents(id),
 project_id uuid NOT NULL REFERENCES ac_projects(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 host_id uuid NOT NULL REFERENCES ac_remote_hosts(id),
 artifact_id uuid NOT NULL REFERENCES ac_artifacts(id),
 source_materialization_id uuid NOT NULL REFERENCES ac_remote_source_materializations(id),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL,
 principal_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER ac_remote_artifact_return_immutable BEFORE UPDATE OR DELETE ON ac_remote_artifact_returns
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
