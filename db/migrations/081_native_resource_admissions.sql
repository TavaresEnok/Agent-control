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

-- Membership uses job_id because the admission deliberately precedes a job row.
CREATE FUNCTION ac_native_resource_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO ac_reconciliation_entries(context_id,source,row_id)
 VALUES(NEW.context_id,TG_TABLE_NAME,NEW.job_id) ON CONFLICT(source,row_id) DO UPDATE SET revision=ac_reconciliation_entries.revision+1;
 UPDATE ac_reconciliation_visits v SET active=true FROM ac_reconciliation_entries e
 WHERE e.source=TG_TABLE_NAME AND e.row_id=NEW.job_id AND v.seq=e.seq;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_membership AFTER INSERT OR UPDATE ON ac_native_resource_admissions
 FOR EACH ROW EXECUTE FUNCTION ac_native_resource_membership();
