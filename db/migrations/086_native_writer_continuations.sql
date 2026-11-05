-- Append-only delegation of the SAME never-started writer identity. This never
-- changes its original epoch or transfers the copy to a different intent.
CREATE TABLE ac_worktree_writer_continuations(
 parent_intent_id uuid NOT NULL,run_id uuid NOT NULL,holder_intent_id uuid NOT NULL REFERENCES ac_intents,
 writer_epoch bigint NOT NULL CHECK(writer_epoch>0),manager_epoch bigint NOT NULL CHECK(manager_epoch>writer_epoch),
 job_id uuid NOT NULL REFERENCES ac_operations,grant_id uuid NOT NULL REFERENCES ac_capacity_grants,
 admission_id uuid NOT NULL,proof_digest text NOT NULL CHECK(proof_digest ~ '^[a-f0-9]{64}$'),proof jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(parent_intent_id,run_id,manager_epoch),
 FOREIGN KEY(parent_intent_id,run_id) REFERENCES ac_worktree_writers,
 UNIQUE(admission_id,manager_epoch));
CREATE FUNCTION ac_immutable_writer_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'WORKTREE_CONTINUATION_IMMUTABLE'; END $$;
CREATE TRIGGER immutable_writer_continuation BEFORE UPDATE OR DELETE ON ac_worktree_writer_continuations
 FOR EACH ROW EXECUTE FUNCTION ac_immutable_writer_continuation();
