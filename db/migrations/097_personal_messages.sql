-- Local personal transcript. Additive: ac_chat_messages stays the Happier outbox.
-- local_message_id is unused until a local transport publishes a notice.
CREATE TABLE ac_personal_messages (
  id text PRIMARY KEY,
  context_id uuid NOT NULL REFERENCES ac_contexts(id),
  role text NOT NULL CHECK (role IN ('owner','manager')),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  local_id text NOT NULL,
  accepted boolean NOT NULL DEFAULT false,
  UNIQUE (context_id, local_id)
);
CREATE INDEX ac_personal_messages_context_seq ON ac_personal_messages (context_id, seq);
CREATE INDEX ac_personal_messages_owner_queue ON ac_personal_messages (context_id, seq) WHERE role = 'owner' AND NOT accepted;
ALTER TABLE ac_notification_items ADD COLUMN local_message_id text REFERENCES ac_personal_messages(id);
