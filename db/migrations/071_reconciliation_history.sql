-- Stable membership sequence: neither UUID ordering nor mutable/timestamp cursors
-- can permanently omit late commits or old rows modified after a prior visit.
CREATE TABLE ac_reconciliation_entries (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 context_id uuid NOT NULL REFERENCES ac_contexts,
 source text NOT NULL,
 row_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 0,
 UNIQUE(source,row_id)
);
CREATE INDEX ac_reconciliation_entries_scan ON ac_reconciliation_entries(context_id,source,seq);
CREATE TABLE ac_reconciliation_progress (
 context_id uuid NOT NULL REFERENCES ac_contexts,
 lane text NOT NULL,
 cursor_seq bigint NOT NULL DEFAULT 0,
 ceiling_seq bigint NOT NULL DEFAULT 0,
 floor_seq bigint NOT NULL DEFAULT 0,
 revision bigint NOT NULL DEFAULT 0,
 sweep bigint NOT NULL DEFAULT 0,
 manager_epoch bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(context_id,lane)
);
CREATE TABLE ac_reconciliation_visits (
 context_id uuid NOT NULL REFERENCES ac_contexts,
 lane text NOT NULL,
 seq bigint NOT NULL REFERENCES ac_reconciliation_entries ON DELETE CASCADE,
 revision bigint NOT NULL,
 active boolean NOT NULL,
 PRIMARY KEY(context_id,lane,seq)
);
CREATE INDEX ac_reconciliation_visits_active ON ac_reconciliation_visits(context_id,lane,seq) WHERE active;
CREATE FUNCTION ac_reconciliation_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO ac_reconciliation_entries(context_id,source,row_id)
 VALUES(NEW.context_id,TG_TABLE_NAME,NEW.id) ON CONFLICT(source,row_id) DO UPDATE SET revision=ac_reconciliation_entries.revision+1;
 UPDATE ac_reconciliation_visits v SET active=true
 FROM ac_reconciliation_entries e WHERE e.source=TG_TABLE_NAME AND e.row_id=NEW.id AND v.seq=e.seq;
 RETURN NEW;
END $$;
DO $$ DECLARE source_name text; BEGIN
 FOREACH source_name IN ARRAY ARRAY['ac_intents','ac_semantic_planning_calls','ac_native_execution_jobs','ac_sandbox_jobs','ac_native_qa_jobs','ac_remote_operations'] LOOP
  EXECUTE format('INSERT INTO ac_reconciliation_entries(context_id,source,row_id) SELECT context_id,%L,id FROM %I ORDER BY created_at,id',source_name,source_name);
  EXECUTE format('CREATE TRIGGER reconciliation_membership AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ac_reconciliation_membership()',source_name);
 END LOOP;
END $$;
