-- Append-only owner revocations; existing authorizations and artifact waivers remain immutable.
CREATE TABLE ac_qa_waiver_revocations(
 authorization_id uuid PRIMARY KEY REFERENCES ac_qa_waiver_authorizations(id),
 principal_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER ac_qa_waiver_revocation_immutable BEFORE UPDATE OR DELETE ON ac_qa_waiver_revocations
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
