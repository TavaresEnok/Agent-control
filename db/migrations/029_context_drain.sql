-- Drain finishes accepted workflows, including their queued verification, but
-- prevents admitting another plan. It never implies pause or process exit.
ALTER TABLE ac_contexts ADD COLUMN draining boolean NOT NULL DEFAULT false;
ALTER TABLE ac_contexts ADD COLUMN drain_revision integer NOT NULL DEFAULT 0 CHECK (drain_revision >= 0);
