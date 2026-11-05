-- Resource waits are independent of provider quota; uncertainty retains its grant.
CREATE TABLE ac_native_resource_admissions (
 job_id uuid PRIMARY KEY, grant_id uuid NOT NULL UNIQUE REFERENCES ac_capacity_grants(id),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),manager_epoch bigint NOT NULL,
 authority_id text NOT NULL,names jsonb NOT NULL,admission_id uuid,state_root text NOT NULL,
 state text NOT NULL CHECK(state IN ('waiting','admitted','uncertain','canceled')),
 reason text NOT NULL CHECK(reason IN ('physical_capacity','human_pause','admitted','uncertain','canceled')),
 proof jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION ac_guard_native_resource_admission_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='released' AND OLD.state<>'released'
  AND EXISTS(SELECT 1 FROM ac_native_resource_admissions r WHERE r.grant_id=NEW.id AND r.state<>'canceled')
  AND NOT EXISTS(SELECT 1 FROM ac_native_execution_jobs WHERE grant_id=NEW.id)
  AND NOT EXISTS(SELECT 1 FROM ac_native_planning_jobs WHERE grant_id=NEW.id)
  AND NOT EXISTS(SELECT 1 FROM ac_native_qa_jobs WHERE grant_id=NEW.id)
 THEN RAISE EXCEPTION 'NATIVE_RESOURCE_ADMISSION_UNCERTAIN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_native_resource_admission_release BEFORE UPDATE OF state ON ac_capacity_grants
 FOR EACH ROW EXECUTE FUNCTION ac_guard_native_resource_admission_release();
