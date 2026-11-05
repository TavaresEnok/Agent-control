-- The emitting transition commits independently before SSH while authority and
-- quota locks remain held. A controller crash cannot roll it back after effect.
CREATE TABLE ac_remote_implementation_emissions (
 operation_id uuid PRIMARY KEY REFERENCES ac_operations,
 workspace_id uuid NOT NULL UNIQUE REFERENCES ac_remote_development_implementations(workspace_id),
 grant_id uuid NOT NULL UNIQUE REFERENCES ac_capacity_grants,
 manager_epoch bigint NOT NULL CHECK(manager_epoch>0),
 phase text NOT NULL CHECK(phase IN ('pending','emitting','no_effect')),
 entered_at timestamptz,
 reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((phase='pending' AND entered_at IS NULL AND reason IS NULL) OR
       (phase='emitting' AND entered_at IS NOT NULL AND reason IS NULL) OR
       (phase='no_effect' AND entered_at IS NULL AND reason IS NOT NULL))
);
CREATE FUNCTION ac_remote_emission_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.phase<>'pending' OR NEW.phase='pending' OR
    (to_jsonb(NEW)-'phase'-'entered_at'-'reason') IS DISTINCT FROM
    (to_jsonb(OLD)-'phase'-'entered_at'-'reason') THEN RAISE EXCEPTION 'REMOTE_EMISSION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_remote_emission_transition BEFORE UPDATE ON ac_remote_implementation_emissions
 FOR EACH ROW EXECUTE FUNCTION ac_remote_emission_transition();
CREATE TRIGGER ac_remote_emission_no_delete BEFORE DELETE ON ac_remote_implementation_emissions
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
