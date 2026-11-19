ALTER TABLE ac_verify_runs
  ADD COLUMN collector_start_pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT ac_verify_collector_start_identity CHECK (
    NOT collector_start_pending OR collector_container_id IS NOT NULL
  );

-- R7 could have sent start for any journal with a durable ID.
UPDATE ac_verify_runs SET collector_start_pending = true
  WHERE collector_container_id IS NOT NULL;

CREATE INDEX ac_verify_pending_collector_start ON ac_verify_runs(context_id)
  WHERE collector_start_pending;

-- Protect all epoch writers, including workflow rollover. Lease expiration
-- still works so a candidate can recover the container before taking authority.
CREATE FUNCTION ac_guard_collector_start_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.epoch <> OLD.epoch OR NEW.instance_id <> OLD.instance_id)
    AND EXISTS (SELECT 1 FROM ac_verify_runs WHERE context_id = OLD.context_id AND collector_start_pending)
  THEN
    RAISE EXCEPTION 'VERIFY_CONTAINER_CLEANUP_PENDING' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ac_collector_start_transfer_guard
  BEFORE UPDATE OF epoch, instance_id ON ac_managers
  FOR EACH ROW EXECUTE FUNCTION ac_guard_collector_start_transfer();
