-- Paths are exposed only through the authenticated native projection with project ACL.
CREATE TABLE ac_project_repositories (
 project_id uuid PRIMARY KEY REFERENCES ac_projects(id),
 repo text NOT NULL UNIQUE,
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
