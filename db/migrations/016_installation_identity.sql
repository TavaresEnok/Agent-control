CREATE TABLE ac_installation_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),id uuid NOT NULL UNIQUE);
INSERT INTO ac_installation_identity(singleton,id) VALUES(true,gen_random_uuid());
CREATE TRIGGER ac_installation_identity_immutable BEFORE UPDATE OR DELETE ON ac_installation_identity
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
