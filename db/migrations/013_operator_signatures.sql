CREATE TABLE ac_operator_keys(id uuid PRIMARY KEY,principal_id text NOT NULL,
 public_key text NOT NULL,state text NOT NULL CHECK(state IN ('active','revoked')),
 enrolled_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ac_operator_keys_principal ON ac_operator_keys(principal_id);
