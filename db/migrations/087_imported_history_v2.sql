-- Historical archives are never live plans, verification evidence or approvals.
CREATE TABLE ac_import_v2_batches(
 batch_id uuid PRIMARY KEY REFERENCES ac_import_batches,
 cursor_key bytea NOT NULL CHECK(octet_length(cursor_key)=32));
CREATE TABLE ac_imported_history_contexts(
 entry_id uuid PRIMARY KEY REFERENCES ac_import_entries,
 source_position integer NOT NULL CHECK(source_position>=0),
 context_digest text NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),
 history_digest text NOT NULL CHECK(history_digest ~ '^[a-f0-9]{64}$'));
CREATE TABLE ac_imported_history_records(
 entry_id uuid NOT NULL REFERENCES ac_imported_history_contexts,
 position integer NOT NULL CHECK(position>=0),
 kind text NOT NULL CHECK(kind IN ('plan','evidence','run')),
 external_id text NOT NULL CHECK(external_id ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL CHECK(revision>0),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
 record_digest text NOT NULL CHECK(record_digest ~ '^[a-f0-9]{64}$'),
 trust text NOT NULL DEFAULT 'historical_untrusted' CHECK(trust='historical_untrusted'),
 executable boolean NOT NULL DEFAULT false CHECK(NOT executable),
 PRIMARY KEY(entry_id,kind,external_id,revision),UNIQUE(entry_id,position));
CREATE TABLE ac_import_v2_entry_aliases(
 batch_id uuid NOT NULL REFERENCES ac_import_batches,
 entry_id uuid NOT NULL REFERENCES ac_imported_history_contexts,
 position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(batch_id,entry_id),UNIQUE(batch_id,position));
CREATE FUNCTION ac_reject_imported_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMPORTED_HISTORY_IMMUTABLE'; END;
$$;
CREATE TRIGGER ac_imported_history_context_immutable BEFORE UPDATE OR DELETE ON ac_imported_history_contexts FOR EACH ROW EXECUTE FUNCTION ac_reject_imported_history_mutation();
CREATE TRIGGER ac_imported_history_record_immutable BEFORE UPDATE OR DELETE ON ac_imported_history_records FOR EACH ROW EXECUTE FUNCTION ac_reject_imported_history_mutation();
CREATE TRIGGER ac_imported_history_alias_immutable BEFORE UPDATE OR DELETE ON ac_import_v2_entry_aliases FOR EACH ROW EXECUTE FUNCTION ac_reject_imported_history_mutation();

CREATE TRIGGER ac_import_v2_batch_immutable BEFORE UPDATE OR DELETE ON ac_import_v2_batches FOR EACH ROW EXECUTE FUNCTION ac_reject_imported_history_mutation();
