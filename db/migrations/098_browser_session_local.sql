-- A personal session can be a cookie with no Happier bearer.
-- The encrypted bearer columns stay together: all set, or all null.
ALTER TABLE ac_browser_sessions ALTER COLUMN token_ciphertext DROP NOT NULL;
ALTER TABLE ac_browser_sessions ALTER COLUMN nonce DROP NOT NULL;
ALTER TABLE ac_browser_sessions ALTER COLUMN tag DROP NOT NULL;
ALTER TABLE ac_browser_sessions ADD CONSTRAINT ac_browser_sessions_credential_complete CHECK (
 (token_ciphertext IS NULL AND nonce IS NULL AND tag IS NULL) OR
 (token_ciphertext IS NOT NULL AND nonce IS NOT NULL AND tag IS NOT NULL));
