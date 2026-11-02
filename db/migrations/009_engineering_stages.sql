ALTER TABLE ac_operations ADD COLUMN native_session_id uuid;
CREATE TABLE ac_execution_contracts(intent_id uuid PRIMARY KEY REFERENCES ac_intents,
 project_id uuid NOT NULL REFERENCES ac_projects, quality_revision integer NOT NULL,
 target_ref text NOT NULL, digest text NOT NULL,
 FOREIGN KEY(project_id,quality_revision) REFERENCES ac_quality_policies(project_id,revision));
CREATE TRIGGER ac_execution_contract_immutable BEFORE UPDATE OR DELETE ON ac_execution_contracts
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_stage_operations(id uuid PRIMARY KEY, intent_id uuid NOT NULL REFERENCES ac_intents,
 node_id text NOT NULL CHECK(node_id IN ('qa','review','integrate')), session_id uuid NOT NULL,
 attempt_id uuid NOT NULL UNIQUE, grant_id uuid REFERENCES ac_capacity_grants,
 manager_epoch bigint NOT NULL, state text NOT NULL CHECK(state IN ('registered','uncertain','running','completed')),
 handle jsonb, receipt jsonb, UNIQUE(intent_id,node_id,session_id));
