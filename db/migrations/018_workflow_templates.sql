ALTER TABLE ac_contexts ADD COLUMN active_template_revision integer;
CREATE TABLE ac_context_templates(context_id uuid NOT NULL REFERENCES ac_contexts,revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,digest text NOT NULL,published_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(context_id,revision));
CREATE TRIGGER ac_context_template_immutable BEFORE UPDATE OR DELETE ON ac_context_templates
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_intent_templates(intent_id uuid PRIMARY KEY REFERENCES ac_intents,context_id uuid NOT NULL,
 template_revision integer NOT NULL,snapshot jsonb NOT NULL,digest text NOT NULL,
 FOREIGN KEY(context_id,template_revision) REFERENCES ac_context_templates(context_id,revision));
CREATE TRIGGER ac_intent_template_immutable BEFORE UPDATE OR DELETE ON ac_intent_templates
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
