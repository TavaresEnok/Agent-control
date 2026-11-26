-- Time given back to the lease by fenced transactions since the last real heartbeat (acquire or heartbeat reset it to 0).
-- The pause also moves heartbeat_at, so a heartbeat queued behind several fenced transactions is not counted late; this
-- total is the absolute ceiling that still stops a manager whose heartbeat stopped from keeping the lease by chaining them.
ALTER TABLE ac_managers ADD COLUMN extended_seconds double precision NOT NULL DEFAULT 0 CHECK (extended_seconds >= 0);
