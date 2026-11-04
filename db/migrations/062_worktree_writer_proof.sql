-- Lab schema only. Disposable databases apply this with the normal migrator.
-- Do not run it against a production installation.
-- Reserved fields only: a mode and digest are not proof of physical isolation.
-- Legacy neutralized rows remain unvalidated and can never be reclaimed.
ALTER TABLE ac_worktree_writers
 ADD COLUMN proof_digest text,
 ADD COLUMN sealed_mode integer,
 ADD CONSTRAINT ac_worktree_writer_proof CHECK(
  (state='held' AND proof_digest IS NULL AND sealed_mode IS NULL) OR
  (state='neutralized' AND proof_digest IS NOT NULL AND proof_digest ~ '^[a-f0-9]{64}$' AND sealed_mode IS NOT NULL AND (sealed_mode & 146)=0)) NOT VALID;
