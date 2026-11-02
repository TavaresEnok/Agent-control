CREATE TABLE IF NOT EXISTS ac_schema_migrations(version integer PRIMARY KEY, digest text NOT NULL);
CREATE TABLE ac_projects(id uuid PRIMARY KEY, label text NOT NULL);
CREATE TABLE ac_memberships(project_id uuid REFERENCES ac_projects, principal_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','operator','viewer')), PRIMARY KEY(project_id,principal_id));
CREATE TABLE ac_contexts(id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES ac_projects,
  paused boolean NOT NULL DEFAULT false, policy_revision integer NOT NULL DEFAULT 1,
  plan_revision integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ac_session_links(session_id text PRIMARY KEY, context_id uuid NOT NULL UNIQUE REFERENCES ac_contexts,
  principal_id text NOT NULL, version integer NOT NULL DEFAULT 1);
CREATE TABLE ac_managers(context_id uuid PRIMARY KEY REFERENCES ac_contexts,
  instance_id uuid NOT NULL, profile_id text NOT NULL, epoch bigint NOT NULL CHECK(epoch>0),
  lease_until timestamptz NOT NULL);
CREATE TABLE ac_checkpoints(context_id uuid PRIMARY KEY REFERENCES ac_contexts,
  epoch bigint NOT NULL, snapshot jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ac_intents(id uuid PRIMARY KEY, context_id uuid NOT NULL REFERENCES ac_contexts,
  principal_id text NOT NULL, digest text NOT NULL, command jsonb NOT NULL,
  operation_id uuid NOT NULL UNIQUE, run_id uuid NOT NULL UNIQUE, manager_epoch bigint NOT NULL,
  plan_revision integer NOT NULL, state text NOT NULL DEFAULT 'accepted', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ac_deliveries(id uuid PRIMARY KEY, intent_id uuid NOT NULL REFERENCES ac_intents,
  channel text NOT NULL CHECK(channel IN ('happier','cockpit','api','mcp','automation')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ac_outbox(id uuid PRIMARY KEY, intent_id uuid NOT NULL UNIQUE REFERENCES ac_intents,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatched')), attempts integer NOT NULL DEFAULT 0);
CREATE TABLE ac_operations(id uuid PRIMARY KEY, intent_id uuid NOT NULL UNIQUE REFERENCES ac_intents,
  state text NOT NULL CHECK(state IN ('registered','running','completed','uncertain')),
  manager_epoch bigint NOT NULL, handle jsonb, receipt jsonb);
CREATE TABLE ac_events(event_id uuid PRIMARY KEY, context_id uuid NOT NULL REFERENCES ac_contexts,
  run_id uuid NOT NULL, plan_revision integer NOT NULL, seq bigint NOT NULL, status text NOT NULL,
  UNIQUE(run_id,seq));
CREATE TABLE ac_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  context_id uuid REFERENCES ac_contexts, kind text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
