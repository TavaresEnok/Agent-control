CREATE TABLE ac_capacity_waits(attempt_id uuid PRIMARY KEY,context_id uuid NOT NULL REFERENCES ac_contexts,
 intent_id uuid NOT NULL REFERENCES ac_intents,role text NOT NULL,request_digest text NOT NULL,
 manager_epoch bigint NOT NULL,desired_profile uuid REFERENCES ac_profiles,
 reason text,priority integer NOT NULL DEFAULT 0,sequence bigint GENERATED ALWAYS AS IDENTITY,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ac_wait_order ON ac_capacity_waits(priority DESC,sequence);
