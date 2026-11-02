-- Account identifiers name real capacity; aliases never create a second resource.
CREATE TABLE ac_control_admins(principal_id text PRIMARY KEY);
CREATE TABLE ac_accounts(
 id uuid PRIMARY KEY, owner_id text NOT NULL, provider text NOT NULL, label text NOT NULL,
 resource_identity text NOT NULL UNIQUE, mode text NOT NULL CHECK(mode='synthetic'),
 eligibility text NOT NULL CHECK(eligibility IN ('documented_supported','requires_clarification','unsupported_for_mode','not_assessed')),
 eligibility_source text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 max_concurrent integer NOT NULL CHECK(max_concurrent BETWEEN 1 AND 128));
CREATE TABLE ac_account_access(account_id uuid NOT NULL REFERENCES ac_accounts,
 project_id uuid NOT NULL REFERENCES ac_projects, PRIMARY KEY(account_id,project_id));
CREATE TABLE ac_profiles(id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES ac_accounts,
 model text NOT NULL, effort text NOT NULL CHECK(effort IN ('low','medium','high')),
 role text NOT NULL CHECK(role IN ('manager','programmer','reviewer','qa','specialist','judge')),
 enabled boolean NOT NULL DEFAULT true);
CREATE TABLE ac_quota_observations(account_id uuid PRIMARY KEY REFERENCES ac_accounts,
 status text NOT NULL CHECK(status IN ('available','exhausted','rate_limited','auth_required','unknown','unreachable','disabled','configuration_error')),
 source text NOT NULL, observed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 CHECK(expires_at>observed_at));
CREATE TABLE ac_capacity_config(id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL,
 programming_limit integer NOT NULL CHECK(programming_limit BETWEEN 1 AND 128),
 evaluation_limit integer NOT NULL CHECK(evaluation_limit BETWEEN 1 AND 128));
CREATE TABLE ac_policy_revisions(project_id uuid NOT NULL REFERENCES ac_projects,
 revision integer NOT NULL CHECK(revision>0), digest text NOT NULL, snapshot jsonb NOT NULL,
 published_by text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,revision));
CREATE FUNCTION ac_reject_policy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'POLICY_REVISION_IMMUTABLE'; END;
$$;
CREATE TRIGGER ac_policy_immutable BEFORE UPDATE OR DELETE ON ac_policy_revisions
FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
ALTER TABLE ac_contexts ADD COLUMN capacity_policy_revision integer;
CREATE TABLE ac_regular_selections(context_id uuid NOT NULL REFERENCES ac_contexts,
 role text NOT NULL, profile_id uuid NOT NULL REFERENCES ac_profiles, policy_revision integer NOT NULL,
 PRIMARY KEY(context_id,role));
CREATE TABLE ac_capacity_grants(id uuid PRIMARY KEY, attempt_id uuid NOT NULL UNIQUE,
 intent_id uuid NOT NULL REFERENCES ac_intents, context_id uuid NOT NULL REFERENCES ac_contexts,
 manager_epoch bigint NOT NULL, account_id uuid NOT NULL REFERENCES ac_accounts,
 profile_id uuid NOT NULL REFERENCES ac_profiles, role text NOT NULL,
 project_id uuid NOT NULL, policy_revision integer NOT NULL, config_revision integer NOT NULL,
 request_digest text NOT NULL, emergency boolean NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','running','uncertain','released')),
 process_handle jsonb, physical_receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,policy_revision) REFERENCES ac_policy_revisions(project_id,revision));
CREATE INDEX ac_grants_account_active ON ac_capacity_grants(account_id) WHERE state<>'released';
CREATE INDEX ac_grants_context_active ON ac_capacity_grants(context_id) WHERE state<>'released';
ALTER TABLE ac_operations ADD COLUMN execution_attempt_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE ac_operations ADD COLUMN grant_id uuid REFERENCES ac_capacity_grants;
