ALTER TABLE ac_accounts ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE ac_profiles ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
