-- A message kept only so its announcement is not repeated, but no longer shown in the conversation.
ALTER TABLE ac_personal_messages ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
