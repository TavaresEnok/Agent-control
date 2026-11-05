-- Pre-effect identity plus absolute deadline for credentialless protocol probes.
CREATE TABLE ac_native_protocol_probe_operations(
 id uuid PRIMARY KEY,
 executor_digest text NOT NULL CHECK(executor_digest ~ '^[a-f0-9]{64}$'),
 worker_image text NOT NULL CHECK(worker_image ~ '^sha256:[a-f0-9]{64}$'),
 phase text NOT NULL CHECK(phase IN ('version','rpc')),
 container_name text NOT NULL UNIQUE,
 container_id text CHECK(container_id IS NULL OR container_id ~ '^[a-f0-9]{64}$'),
 deadline_ms bigint NOT NULL,
 retired boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION ac_protect_native_protocol_probe_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.executor_digest<>OLD.executor_digest OR NEW.worker_image<>OLD.worker_image
  OR NEW.phase<>OLD.phase OR NEW.container_name<>OLD.container_name OR NEW.deadline_ms<>OLD.deadline_ms
  OR NEW.created_at<>OLD.created_at OR (OLD.container_id IS NOT NULL AND NEW.container_id IS DISTINCT FROM OLD.container_id)
  OR (OLD.retired AND NOT NEW.retired)
 THEN RAISE EXCEPTION 'NATIVE_PROTOCOL_PROBE_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER ac_native_protocol_probe_identity BEFORE UPDATE OR DELETE ON ac_native_protocol_probe_operations
FOR EACH ROW EXECUTE FUNCTION ac_protect_native_protocol_probe_identity();
