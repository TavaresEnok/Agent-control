-- A project removed from the installation stays in the ledger (receipts, history and policy chains keep pointing at it),
-- marked here with the moment it was archived. Idempotent: the column is only added when missing.
ALTER TABLE ac_projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
