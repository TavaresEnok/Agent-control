-- Immutable provenance for a local working repository bound from an authorized SSH source snapshot.
-- Version 1 records the binding. It does not approve the snapshot or authorize integration.
CREATE TABLE ac_remote_source_materializations (
 schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
 id uuid PRIMARY KEY REFERENCES ac_project_admin_intents(id),
 project_id uuid NOT NULL UNIQUE REFERENCES ac_projects(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 host_id uuid NOT NULL REFERENCES ac_remote_hosts(id),
 operation_id uuid NOT NULL UNIQUE REFERENCES ac_remote_operations(id),
 commit_id text NOT NULL CHECK (commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 tree_id text NOT NULL CHECK (tree_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 bundle_sha256 text NOT NULL CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
 authorization_id uuid NOT NULL REFERENCES ac_remote_source_authorizations(control_intent_id),
 principal_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (length(commit_id) = length(tree_id))
);
CREATE TRIGGER ac_remote_source_materialization_immutable BEFORE UPDATE OR DELETE ON ac_remote_source_materializations
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
