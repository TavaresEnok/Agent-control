CREATE TABLE ac_workflow_graph_revisions (
 project_id uuid NOT NULL REFERENCES ac_projects,
 name text NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name)<=80),
 revision integer NOT NULL CHECK (revision>0),
 snapshot jsonb NOT NULL, file_digest text NOT NULL CHECK (file_digest ~ '^[a-f0-9]{64}$'),
 published_by text NOT NULL, published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,name,revision)
);
CREATE TRIGGER ac_workflow_graph_revisions_immutable BEFORE UPDATE OR DELETE ON ac_workflow_graph_revisions
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_workflow_graph_heads (
 project_id uuid NOT NULL, name text NOT NULL, revision integer NOT NULL,
 PRIMARY KEY(project_id,name), FOREIGN KEY(project_id,name,revision) REFERENCES ac_workflow_graph_revisions
);
-- Pending publication survives a process crash between rename and database commit.
CREATE TABLE ac_workflow_graph_intents (
 id uuid PRIMARY KEY, principal_id text NOT NULL, payload_digest text NOT NULL,
 project_id uuid NOT NULL REFERENCES ac_projects, name text NOT NULL, expected_revision integer NOT NULL,
 snapshot jsonb NOT NULL, repository_identity jsonb NOT NULL, desired_digest text NOT NULL,
 desired_bytes bytea NOT NULL, state text NOT NULL CHECK(state IN ('pending','applied')),
 result jsonb, CHECK ((state='pending' AND result IS NULL) OR (state='applied' AND result IS NOT NULL))
);
CREATE UNIQUE INDEX ac_workflow_graph_one_pending ON ac_workflow_graph_intents(project_id,name) WHERE state='pending';
CREATE TABLE ac_workflow_graph_deliveries (
 id uuid PRIMARY KEY, intent_id uuid NOT NULL REFERENCES ac_workflow_graph_intents
);
