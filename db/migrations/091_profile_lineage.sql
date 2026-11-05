CREATE TABLE ac_profile_lineage (
 new_profile_id uuid PRIMARY KEY REFERENCES ac_profiles(id),
 source_profile_id uuid NOT NULL REFERENCES ac_profiles(id),
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(new_profile_id<>source_profile_id)
);
CREATE TRIGGER ac_profile_lineage_immutable BEFORE UPDATE OR DELETE ON ac_profile_lineage
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
