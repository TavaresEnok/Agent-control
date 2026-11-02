CREATE TABLE ac_control_intents(id uuid PRIMARY KEY, context_id uuid NOT NULL REFERENCES ac_contexts,
 principal_id text NOT NULL, payload_digest text NOT NULL, action text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ac_control_deliveries(id uuid PRIMARY KEY, intent_id uuid NOT NULL REFERENCES ac_control_intents,
 created_at timestamptz NOT NULL DEFAULT now());
