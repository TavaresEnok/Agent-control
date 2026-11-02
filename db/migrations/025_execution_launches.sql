CREATE TABLE ac_execution_launches(operation_id uuid PRIMARY KEY REFERENCES ac_operations,
 context_id uuid NOT NULL REFERENCES ac_contexts,manager_epoch bigint NOT NULL,
 snapshot jsonb NOT NULL,digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER ac_execution_launch_immutable BEFORE UPDATE OR DELETE ON ac_execution_launches
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
