-- Structured observations are not a second transcript: only bounded status
-- metadata is persisted here; rendered text enters the existing E2EE outbox.
CREATE TABLE ac_notification_cursors (
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 entity_id uuid NOT NULL,
 source text NOT NULL CHECK (source IN ('runtime','admission','cancellation','manager')),
 revision bigint NOT NULL DEFAULT 0,
 observed_seq bigint NOT NULL DEFAULT -1,
 semantic_digest text NOT NULL DEFAULT '',
 manager_epoch bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(context_id,entity_id,source)
);
CREATE TABLE ac_notification_items (
 id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
 context_id uuid NOT NULL REFERENCES ac_contexts(id),
 session_id text NOT NULL REFERENCES ac_session_links(session_id),
 entity_id uuid NOT NULL,
 source text NOT NULL CHECK (source IN ('runtime','admission','cancellation','manager')),
 revision bigint NOT NULL CHECK (revision>0),
 plan_revision integer NOT NULL CHECK (plan_revision>=0),
 observed_seq bigint NOT NULL CHECK (observed_seq>=0),
 kind text NOT NULL CHECK (kind IN ('completion','blocker')),
 status text NOT NULL CHECK(status IN ('pending','queued','running','waiting','done','review','failed','cancelled','canceled','cancel_requested','cancel_confirmed','blocked','recovered','unknown')),
 reason text NOT NULL CHECK(reason IN ('NONE','CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED','HUMAN_PAUSED','ADMISSION_CLOSED','STORAGE_LOW_SPACE','DISK_OBSERVATION_UNAVAILABLE','PLAN_CANCELLATION_REQUESTED','RECONCILIATION_REQUIRED','EXECUTION_FAILED','EXECUTION_WAITING','RUNTIME_UNAVAILABLE')),
 manager_epoch bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 available_at timestamptz NOT NULL,
 superseded boolean NOT NULL DEFAULT false,
 message_id text REFERENCES ac_chat_messages(id),
 UNIQUE(context_id,entity_id,source,revision)
);
CREATE INDEX ac_notification_pending ON ac_notification_items(context_id,session_id,kind,created_at)
 WHERE message_id IS NULL AND NOT superseded;
ALTER TABLE ac_chat_messages ADD COLUMN priority integer NOT NULL DEFAULT 0 CHECK(priority IN (0,50,100));
CREATE INDEX ac_chat_outgoing_priority ON ac_chat_messages(session_id,priority DESC,sequence) WHERE NOT sent;
CREATE TABLE ac_chat_publication_receipts (
 message_id text PRIMARY KEY REFERENCES ac_chat_messages(id),
 session_id text NOT NULL REFERENCES ac_session_links(session_id),
 provider_message_id text NOT NULL,
 provider_seq bigint NOT NULL CHECK(provider_seq>0),
 local_id text NOT NULL,
 identity_digest text NOT NULL,
 acknowledged_epoch bigint NOT NULL CHECK(acknowledged_epoch>0),
 acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER ac_chat_publication_immutable BEFORE UPDATE OR DELETE ON ac_chat_publication_receipts
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
