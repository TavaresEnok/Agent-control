-- When the manager last proved it is alive (acquire or heartbeat). A fenced transaction gives the lease back the time it held
-- the context anchor only while this is recent, so a manager whose heartbeat stopped cannot keep its lease by chaining them.
ALTER TABLE ac_managers ADD COLUMN heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp();
