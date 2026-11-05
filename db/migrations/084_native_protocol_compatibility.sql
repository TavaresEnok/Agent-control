-- Immutable local protocol observations. Eligibility/authentication are separate gates.
CREATE TABLE ac_native_protocol_receipts(
 id uuid PRIMARY KEY,
 executor_digest text NOT NULL CHECK(executor_digest ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('execution','planning')),
 worker_image text NOT NULL CHECK(worker_image ~ '^sha256:[a-f0-9]{64}$'),
 tools_image text CHECK(tools_image IS NULL OR tools_image ~ '^sha256:[a-f0-9]{64}$'),
 cli_version text NOT NULL,
 protocol text NOT NULL CHECK(protocol='codex-app-server-initialize-model-list-v1'),
 models jsonb NOT NULL CHECK(jsonb_typeof(models)='array'),
 transcript_digest text NOT NULL CHECK(transcript_digest ~ '^[a-f0-9]{64}$'),
 principal_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION ac_reject_native_protocol_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'NATIVE_PROTOCOL_RECEIPT_IMMUTABLE'; END;
$$;
CREATE TRIGGER ac_native_protocol_receipt_immutable BEFORE UPDATE OR DELETE ON ac_native_protocol_receipts
FOR EACH ROW EXECUTE FUNCTION ac_reject_native_protocol_mutation();
CREATE TABLE ac_native_protocol_promotions(
 executor_digest text PRIMARY KEY CHECK(executor_digest ~ '^[a-f0-9]{64}$'),
 receipt_id uuid NOT NULL REFERENCES ac_native_protocol_receipts,
 revision integer NOT NULL CHECK(revision>0),
 revoked boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE ac_native_protocol_attempt_pins(
 kind text NOT NULL CHECK(kind IN ('execution','planning')),
 job_id uuid NOT NULL,
 executor_digest text NOT NULL,
 receipt_id uuid NOT NULL REFERENCES ac_native_protocol_receipts,
 model text NOT NULL,
 effort text NOT NULL CHECK(effort IN ('low','medium','high')),
 PRIMARY KEY(kind,job_id));
CREATE TRIGGER ac_native_protocol_pin_immutable BEFORE UPDATE OR DELETE ON ac_native_protocol_attempt_pins
FOR EACH ROW EXECUTE FUNCTION ac_reject_native_protocol_mutation();
