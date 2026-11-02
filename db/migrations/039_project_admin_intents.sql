CREATE TABLE ac_project_admin_intents(
 id uuid PRIMARY KEY, principal_id text NOT NULL, payload_digest text NOT NULL,
 action text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ac_project_repository_identity(
 project_id uuid PRIMARY KEY REFERENCES ac_projects(id), repo_dev text NOT NULL, repo_ino text NOT NULL,
 git_dev text NOT NULL, git_ino text NOT NULL, root_id text NOT NULL, root_path text NOT NULL, relative_path text NOT NULL
);
CREATE TABLE ac_project_admin_deliveries(
 id uuid PRIMARY KEY, intent_id uuid NOT NULL REFERENCES ac_project_admin_intents(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
