CREATE TABLE ac_remote_hosts(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES ac_projects,
 label text NOT NULL,hostname text NOT NULL,port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),
 username text NOT NULL,public_key text NOT NULL,fingerprint text NOT NULL,credential_ref uuid NOT NULL,
 remote_root text NOT NULL,allowed_tasks text[] NOT NULL,max_concurrent integer NOT NULL CHECK(max_concurrent BETWEEN 1 AND 32),
 enabled boolean NOT NULL DEFAULT true,registration_digest text NOT NULL);
CREATE TABLE ac_remote_operations(id uuid PRIMARY KEY,context_id uuid NOT NULL REFERENCES ac_contexts,
 host_id uuid NOT NULL REFERENCES ac_remote_hosts,task_id text NOT NULL,request_digest text NOT NULL,
 manager_epoch bigint NOT NULL,state text NOT NULL CHECK(state IN ('registered','uncertain','running','completed','failed','canceled_confirmed')),
 remote_receipt jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ac_remote_host_active ON ac_remote_operations(host_id) WHERE state NOT IN ('completed','failed','canceled_confirmed');
