CREATE TABLE ac_operator_bootstrap(principal_id text PRIMARY KEY, token_digest text NOT NULL,
 expires_at timestamptz NOT NULL, failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts>=0),
 used boolean NOT NULL DEFAULT false, created_by text NOT NULL);
