-- Lab schema only. Disposable databases apply this with the normal migrator.
-- Do not run it against a production installation.
-- Additive pin of the runtime build and the workflow version frozen for one execution epoch.
-- Existing ac_frozen_plans rows are not rewritten. A plan frozen before this migration has no pin;
-- the runtime derives the version from the frozen digest and the in-code registry. Absence is not retirement.
CREATE TABLE ac_workflow_version_pins(
 intent_id uuid PRIMARY KEY REFERENCES ac_intents,
 context_id uuid NOT NULL REFERENCES ac_contexts,
 manager_epoch bigint NOT NULL CHECK(manager_epoch>0),
 workflow_name text NOT NULL CHECK(char_length(workflow_name) BETWEEN 1 AND 120),
 workflow_version text NOT NULL CHECK(char_length(workflow_version) BETWEEN 1 AND 64),
 workflow_digest text NOT NULL CHECK(workflow_digest ~ '^[a-f0-9]{64}$'),
 runtime_version text NOT NULL CHECK(char_length(runtime_version) BETWEEN 1 AND 80),
 runtime_build text NOT NULL CHECK(char_length(runtime_build) BETWEEN 1 AND 80),
 policy text NOT NULL CHECK(policy='pinned'),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION ac_reject_workflow_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'WORKFLOW_VERSION_PIN_IMMUTABLE'; END;
$$;
CREATE TRIGGER ac_workflow_version_pin_immutable BEFORE UPDATE OR DELETE ON ac_workflow_version_pins
FOR EACH ROW EXECUTE FUNCTION ac_reject_workflow_version_mutation();
