-- Frozen source identity for a scoped native Cezar task, without plaintext chat.
CREATE TABLE ac_native_task_inputs (
 intent_id uuid PRIMARY KEY REFERENCES ac_intents,
 base_id text NOT NULL CHECK(base_id ~ '^[a-f0-9]{40}$'),
 snapshot jsonb NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$')
);
CREATE TRIGGER ac_native_task_inputs_immutable BEFORE UPDATE OR DELETE ON ac_native_task_inputs
 FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
