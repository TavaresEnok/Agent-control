-- Remote development is isolated from its immutable source repository.
CREATE TABLE ac_remote_development_workspaces (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES ac_projects,
 context_id uuid NOT NULL REFERENCES ac_contexts,
 intent_id uuid NOT NULL REFERENCES ac_intents,
 host_id uuid NOT NULL REFERENCES ac_remote_hosts,
 source_operation_id uuid NOT NULL REFERENCES ac_remote_operations,
 source_authorization_id uuid NOT NULL REFERENCES ac_remote_source_authorizations(control_intent_id),
 source_commit text NOT NULL,
 source_tree text NOT NULL,
 request_digest text NOT NULL,
 manager_epoch bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('uncertain','prepared')),
 remote_receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ac_remote_workspace_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'remote_receipt'-'manager_epoch') IS DISTINCT FROM
    (to_jsonb(OLD)-'state'-'remote_receipt'-'manager_epoch') THEN RAISE EXCEPTION 'REMOTE_WORKSPACE_BINDING_IMMUTABLE'; END IF;
 IF OLD.state='prepared' AND (NEW.state<>OLD.state OR NEW.remote_receipt IS DISTINCT FROM OLD.remote_receipt) THEN
  RAISE EXCEPTION 'REMOTE_WORKSPACE_RECEIPT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_remote_workspace_binding_immutable BEFORE UPDATE ON ac_remote_development_workspaces
 FOR EACH ROW EXECUTE FUNCTION ac_remote_workspace_binding_immutable();
CREATE TABLE ac_remote_development_snapshots (
 workspace_id uuid PRIMARY KEY REFERENCES ac_remote_development_workspaces,
 execution_operation_id uuid NOT NULL UNIQUE REFERENCES ac_remote_operations,
 commit_id text NOT NULL,
 tree_id text NOT NULL,
 base_id text NOT NULL,
 bundle_sha256 text NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER ac_remote_development_snapshot_immutable BEFORE UPDATE OR DELETE ON ac_remote_development_snapshots
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_remote_development_implementations (
 workspace_id uuid PRIMARY KEY REFERENCES ac_remote_development_workspaces,
 operation_id uuid NOT NULL UNIQUE REFERENCES ac_operations,
 grant_id uuid NOT NULL UNIQUE REFERENCES ac_capacity_grants,
 session_id uuid NOT NULL UNIQUE,
 task_id text NOT NULL,
 policy_revision integer NOT NULL,
 input_snapshot jsonb NOT NULL,
 input_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER ac_remote_development_implementation_immutable BEFORE UPDATE OR DELETE ON ac_remote_development_implementations
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
