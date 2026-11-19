-- R7 clients update the ID without mentioning collector_start_pending.
CREATE FUNCTION ac_sync_collector_start_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.collector_container_id IS NULL THEN
    NEW.collector_start_pending := false;
  ELSIF OLD.collector_container_id IS DISTINCT FROM NEW.collector_container_id THEN
    NEW.collector_start_pending := true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ac_collector_start_identity_sync
  BEFORE UPDATE OF collector_container_id ON ac_verify_runs
  FOR EACH ROW EXECUTE FUNCTION ac_sync_collector_start_identity();

-- A legacy client may have recorded an ID after 113 was applied.
UPDATE ac_verify_runs SET collector_start_pending = true
  WHERE collector_container_id IS NOT NULL AND NOT collector_start_pending;
