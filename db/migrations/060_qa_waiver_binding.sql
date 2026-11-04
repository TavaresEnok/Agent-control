-- Lab schema only. Disposable databases apply this with the normal migrator.
-- Do not run it against a production installation.
-- Explicit QA waiver binding. A row without these fields is not a valid waiver.
CREATE TABLE ac_qa_waiver_authorizations(
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL,
 policy_revision integer NOT NULL,
 policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
 template_id uuid NOT NULL,
 template_revision integer NOT NULL CHECK(template_revision > 0),
 template_digest text NOT NULL CHECK(template_digest ~ '^[a-f0-9]{64}$'),
 task_id text NOT NULL CHECK(task_id ~ '^[a-z][a-z0-9_-]{0,47}$'),
 risk_rule text NOT NULL CHECK(risk_rule = 'explicit-low'),
 principal_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id, policy_revision, template_id, template_revision, task_id),
 FOREIGN KEY(project_id, policy_revision) REFERENCES ac_quality_policies(project_id, revision),
 FOREIGN KEY(project_id, template_id, template_revision) REFERENCES ac_project_templates(project_id, template_id, revision));
CREATE TRIGGER ac_qa_waiver_authorization_immutable BEFORE UPDATE OR DELETE ON ac_qa_waiver_authorizations
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();

ALTER TABLE ac_qa_waivers
 ADD COLUMN policy_revision integer,
 ADD COLUMN policy_digest text,
 ADD COLUMN template_id uuid,
 ADD COLUMN template_revision integer,
 ADD COLUMN template_digest text,
 ADD COLUMN risk_rule text,
 ADD COLUMN task_id text,
 ADD COLUMN artifact_digest text,
 ADD COLUMN authorization_id uuid REFERENCES ac_qa_waiver_authorizations(id),
 ADD CONSTRAINT ac_qa_waiver_binding_complete CHECK(
  (policy_revision IS NULL AND policy_digest IS NULL AND template_id IS NULL AND template_revision IS NULL
   AND template_digest IS NULL AND risk_rule IS NULL AND task_id IS NULL AND artifact_digest IS NULL AND authorization_id IS NULL)
  OR
  (policy_revision > 0 AND policy_digest ~ '^[a-f0-9]{64}$' AND template_revision > 0
   AND template_digest ~ '^[a-f0-9]{64}$' AND risk_rule = 'explicit-low'
   AND task_id ~ '^[a-z][a-z0-9_-]{0,47}$' AND artifact_digest ~ '^[a-f0-9]{64}$' AND authorization_id IS NOT NULL));
CREATE TRIGGER ac_qa_waiver_immutable BEFORE UPDATE OR DELETE ON ac_qa_waivers
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
