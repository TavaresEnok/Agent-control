-- Decision evidence is absent for grants made before this revision.
ALTER TABLE ac_capacity_grants ADD COLUMN selection jsonb;
