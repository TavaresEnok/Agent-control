CREATE TABLE ac_remote_source_authorizations (
 control_intent_id uuid PRIMARY KEY REFERENCES ac_control_intents(id) DEFERRABLE INITIALLY DEFERRED,
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 project_id uuid NOT NULL REFERENCES ac_projects(id),
 intent_id uuid NOT NULL REFERENCES ac_intents(id),
 host_id uuid NOT NULL REFERENCES ac_remote_hosts(id),
 commit_id text NOT NULL CHECK(commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 tree_id text NOT NULL CHECK(tree_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 commitment_digest text NOT NULL CHECK(commitment_digest ~ '^[a-f0-9]{64}$'),
 principal_id text NOT NULL,
 operator_command jsonb NOT NULL,
 operator_proof jsonb NOT NULL,
 operator_public_key text NOT NULL,
 installation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(length(commit_id)=length(tree_id))
);
CREATE INDEX ac_remote_source_authorization_match ON ac_remote_source_authorizations(context_id,intent_id,host_id,commit_id,tree_id);
CREATE TRIGGER ac_remote_source_authorization_immutable BEFORE UPDATE OR DELETE ON ac_remote_source_authorizations
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
