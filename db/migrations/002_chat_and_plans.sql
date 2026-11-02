CREATE TABLE ac_chat_messages(id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES ac_session_links(session_id), ciphertext text NOT NULL,
  sent boolean NOT NULL DEFAULT false);
CREATE TABLE ac_frozen_plans(context_id uuid NOT NULL REFERENCES ac_contexts,
  revision integer NOT NULL, intent_id uuid NOT NULL UNIQUE REFERENCES ac_intents,
  digest text NOT NULL, snapshot jsonb NOT NULL, PRIMARY KEY(context_id,revision));
CREATE FUNCTION ac_reject_plan_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FROZEN_PLAN_IMMUTABLE'; END;
$$;
CREATE TRIGGER ac_plan_immutable BEFORE UPDATE OR DELETE ON ac_frozen_plans
FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
