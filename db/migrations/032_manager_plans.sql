-- Proposals are immutable and separate from ac_frozen_plans (accepted intents).
-- Creating one does not authorize any physical effect or replace an active run.
CREATE TABLE ac_manager_plans(
 context_id uuid NOT NULL REFERENCES ac_contexts,
 revision integer NOT NULL CHECK(revision>0),
 parent_revision integer,
 manager_epoch bigint NOT NULL CHECK(manager_epoch>0),
 manager_instance_id uuid NOT NULL,
 principal_id text NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 snapshot jsonb NOT NULL,
 compilation_digest text NOT NULL CHECK(compilation_digest ~ '^[0-9a-f]{64}$'),
 compilation jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(context_id,revision),
 FOREIGN KEY(context_id,parent_revision) REFERENCES ac_manager_plans(context_id,revision),
 CHECK((revision=1 AND parent_revision IS NULL) OR (revision>1 AND parent_revision=revision-1))
);
CREATE TRIGGER ac_manager_plan_immutable BEFORE UPDATE OR DELETE ON ac_manager_plans
FOR EACH ROW EXECUTE FUNCTION ac_reject_plan_mutation();
