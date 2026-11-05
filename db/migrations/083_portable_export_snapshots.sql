-- Durable, owner-scoped redacted export cuts; no conversation or credentials.
CREATE TABLE ac_portable_export_snapshots (
 id uuid PRIMARY KEY,
 principal_id text NOT NULL,
 project_id uuid NOT NULL REFERENCES ac_projects,
 context_id uuid NOT NULL REFERENCES ac_contexts,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 cursor_key bytea NOT NULL CHECK(octet_length(cursor_key)=32),
 manifest jsonb NOT NULL
);
CREATE INDEX ac_portable_export_expiry ON ac_portable_export_snapshots(expires_at);
CREATE TABLE ac_portable_export_sections (
 export_id uuid NOT NULL REFERENCES ac_portable_export_snapshots ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
 payload bytea NOT NULL CHECK(octet_length(payload)<=33554432),
 PRIMARY KEY(export_id,ordinal)
);
CREATE TRIGGER ac_portable_export_header_immutable BEFORE UPDATE ON ac_portable_export_snapshots
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TRIGGER ac_portable_export_section_immutable BEFORE UPDATE ON ac_portable_export_sections
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
