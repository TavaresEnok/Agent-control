-- Lab schema only. Disposable databases apply this with the normal migrator.
-- Do not run it against a production installation.
CREATE TABLE ac_project_templates(
 project_id uuid NOT NULL REFERENCES ac_projects,
 template_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80),
 snapshot jsonb NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 published_by text NOT NULL CHECK(char_length(published_by) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,template_id,revision),
 CHECK(jsonb_typeof(snapshot)='object'),
 CHECK(snapshot->>'workflow' IN ('baseline-synthetic-v1','engineering-synthetic-v1','semantic-proposal-v1','engineering-native-v1')),
 CHECK(NOT snapshot ? 'account' AND NOT snapshot ? 'accounts' AND NOT snapshot ? 'credential' AND NOT snapshot ? 'credentials'
  AND NOT snapshot ? 'secret' AND NOT snapshot ? 'token' AND NOT snapshot ? 'transcript' AND NOT snapshot ? 'password'));
CREATE INDEX ac_project_templates_order ON ac_project_templates(project_id,name,template_id,revision);
CREATE TRIGGER ac_project_template_immutable BEFORE UPDATE OR DELETE ON ac_project_templates
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();

ALTER TABLE ac_context_templates
 ADD COLUMN source_project_id uuid,
 ADD COLUMN source_template_id uuid,
 ADD COLUMN source_revision integer,
 ADD CONSTRAINT ac_context_template_source_complete CHECK(
  (source_project_id IS NULL AND source_template_id IS NULL AND source_revision IS NULL) OR
  (source_project_id IS NOT NULL AND source_template_id IS NOT NULL AND source_revision IS NOT NULL)),
 ADD CONSTRAINT ac_context_template_source_fk FOREIGN KEY(source_project_id,source_template_id,source_revision)
  REFERENCES ac_project_templates(project_id,template_id,revision);
