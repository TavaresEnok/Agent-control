CREATE TABLE ac_administrative_policies (
 context_id uuid NOT NULL REFERENCES ac_contexts(id), revision integer NOT NULL CHECK(revision>0),
 digest text NOT NULL, snapshot jsonb NOT NULL, published_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(context_id,revision)
);
CREATE TRIGGER ac_administrative_policies_immutable BEFORE UPDATE OR DELETE ON ac_administrative_policies
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_administrative_operations (
 id uuid PRIMARY KEY, context_id uuid NOT NULL REFERENCES ac_contexts(id), intent_id uuid NOT NULL REFERENCES ac_intents(id),
 principal_id text NOT NULL, operation_name text NOT NULL, operation_version integer NOT NULL,
 executor_digest text NOT NULL, parameter_digest text NOT NULL, policy_revision integer NOT NULL,
 manager_profile_id text NOT NULL, manager_epoch bigint NOT NULL CHECK(manager_epoch>0), state text NOT NULL CHECK(state IN ('registered','running','uncertain','completed')),
 receipt jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(context_id,policy_revision) REFERENCES ac_administrative_policies(context_id,revision)
);
CREATE UNIQUE INDEX ac_administrative_one_inflight ON ac_administrative_operations ((true)) WHERE state IN ('running','uncertain');
