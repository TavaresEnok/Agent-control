ALTER TABLE ac_contexts ADD COLUMN pause_revision integer NOT NULL DEFAULT 0 CHECK(pause_revision>=0);
