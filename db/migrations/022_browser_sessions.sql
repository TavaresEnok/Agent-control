CREATE TABLE ac_browser_sessions(id_digest text PRIMARY KEY,principal_id text NOT NULL,
 token_ciphertext text NOT NULL,nonce text NOT NULL,tag text NOT NULL,
 expires_at timestamptz NOT NULL,revoked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
