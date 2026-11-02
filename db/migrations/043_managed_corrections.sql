-- Decisions and selected artifacts are append-only; they never authorize a
-- physical effect without the current controller fence and executor checks.
CREATE TABLE ac_managed_correction_decisions (
 parent_intent_id uuid NOT NULL REFERENCES ac_intents(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 task_id text NOT NULL CHECK (task_id ~ '^[a-z][a-z0-9_-]{0,47}$'),
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 5),
 prior_intent_id uuid NOT NULL REFERENCES ac_intents(id),
 prior_artifact_id uuid NOT NULL REFERENCES ac_artifacts(id),
 failed_evidence_ids uuid[] NOT NULL CHECK (cardinality(failed_evidence_ids) BETWEEN 1 AND 32),
 prior_commit text NOT NULL CHECK (prior_commit ~ '^[a-f0-9]{40}$'),
 prior_tree text NOT NULL CHECK (prior_tree ~ '^[a-f0-9]{40}$'),
 base_id text NOT NULL CHECK (base_id ~ '^[a-f0-9]{40}$'),
 next_intent_id uuid NOT NULL UNIQUE REFERENCES ac_intents(id),
 manager_epoch bigint NOT NULL CHECK (manager_epoch>0),
 decision_digest text NOT NULL CHECK (decision_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(parent_intent_id,task_id,revision),
 CHECK (prior_intent_id<>next_intent_id)
);
CREATE TRIGGER ac_managed_correction_decisions_immutable BEFORE UPDATE OR DELETE ON ac_managed_correction_decisions
 FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
CREATE TABLE ac_managed_task_selections (
 parent_intent_id uuid NOT NULL REFERENCES ac_intents(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 task_id text NOT NULL CHECK (task_id ~ '^[a-z][a-z0-9_-]{0,47}$'),
 selected_intent_id uuid NOT NULL UNIQUE REFERENCES ac_intents(id),
 artifact_id uuid NOT NULL REFERENCES ac_artifacts(id),
 selection_digest text NOT NULL CHECK (selection_digest ~ '^[a-f0-9]{64}$'),
 manager_epoch bigint NOT NULL CHECK (manager_epoch>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(parent_intent_id,task_id)
);
CREATE TRIGGER ac_managed_task_selections_immutable BEFORE UPDATE OR DELETE ON ac_managed_task_selections
 FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
