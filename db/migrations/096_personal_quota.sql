-- Personal use: an exhausted account is skipped until the provider reset.
-- Plans can start without a second tap when the project owner turns that on.
ALTER TABLE ac_accounts ADD COLUMN exhausted_until timestamptz;
ALTER TABLE ac_projects ADD COLUMN auto_approve_plans boolean NOT NULL DEFAULT false;
