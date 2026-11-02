CREATE TABLE ac_quality_policies(project_id uuid NOT NULL REFERENCES ac_projects, revision integer NOT NULL,
 snapshot jsonb NOT NULL, digest text NOT NULL, PRIMARY KEY(project_id,revision));
CREATE TRIGGER ac_quality_policy_immutable BEFORE UPDATE OR DELETE ON ac_quality_policies
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_artifacts(id uuid PRIMARY KEY, context_id uuid NOT NULL REFERENCES ac_contexts,
 intent_id uuid NOT NULL REFERENCES ac_intents, implementation_grant_id uuid NOT NULL REFERENCES ac_capacity_grants,
 implementation_session_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES ac_projects,
 policy_revision integer NOT NULL, commit_id text NOT NULL, tree_id text NOT NULL, base_id text NOT NULL,
 identity_digest text NOT NULL, risk text NOT NULL CHECK(risk IN ('low','medium','high')),
 FOREIGN KEY(project_id,policy_revision) REFERENCES ac_quality_policies(project_id,revision));
CREATE TRIGGER ac_artifact_immutable BEFORE UPDATE OR DELETE ON ac_artifacts
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_verification_evidence(id uuid PRIMARY KEY, artifact_id uuid NOT NULL REFERENCES ac_artifacts,
 kind text NOT NULL CHECK(kind IN ('qa','review')), session_id uuid NOT NULL,
 grant_id uuid NOT NULL REFERENCES ac_capacity_grants, policy_revision integer NOT NULL,
 status text NOT NULL CHECK(status IN ('passed','failed','canceled','missing_result','stale')),
 receipt jsonb NOT NULL, receipt_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(artifact_id,kind,session_id));
CREATE TRIGGER ac_verification_immutable BEFORE UPDATE OR DELETE ON ac_verification_evidence
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_qa_waivers(artifact_id uuid PRIMARY KEY REFERENCES ac_artifacts,
 principal_id text NOT NULL, reason_ref text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ac_integration_intents(id uuid PRIMARY KEY, artifact_id uuid NOT NULL UNIQUE REFERENCES ac_artifacts,
 context_id uuid NOT NULL REFERENCES ac_contexts, manager_epoch bigint NOT NULL,
 target_ref text NOT NULL, state text NOT NULL CHECK(state IN ('registered','uncertain','integrated','rejected')),
 receipt jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ac_integration_approvals(artifact_id uuid NOT NULL REFERENCES ac_artifacts,
 target_ref text NOT NULL, principal_id text NOT NULL, artifact_digest text NOT NULL,
 policy_revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(artifact_id,target_ref));
CREATE TRIGGER ac_integration_approval_immutable BEFORE UPDATE OR DELETE ON ac_integration_approvals
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
