-- Laboratory authority is isolated from operational installations and credentials.
CREATE TABLE ac_installation_domains (
 id uuid PRIMARY KEY, label text NOT NULL, holder_installation_id uuid NOT NULL,
 epoch integer NOT NULL DEFAULT 1 CHECK(epoch>0), paused boolean NOT NULL DEFAULT true,
 mode text NOT NULL DEFAULT 'synthetic-laboratory' CHECK(mode='synthetic-laboratory')
);
CREATE TABLE ac_installation_members (
 id uuid PRIMARY KEY, domain_id uuid NOT NULL REFERENCES ac_installation_domains(id),
 label text NOT NULL, UNIQUE(domain_id,id)
);
ALTER TABLE ac_installation_domains ADD CONSTRAINT installation_holder_member
 FOREIGN KEY(id,holder_installation_id) REFERENCES ac_installation_members(domain_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE ac_installation_reservations (
 id uuid PRIMARY KEY, domain_id uuid NOT NULL REFERENCES ac_installation_domains(id),
 installation_id uuid NOT NULL, epoch integer NOT NULL, operation_id uuid NOT NULL,
 account_id uuid NOT NULL REFERENCES ac_accounts(id), execution_identity uuid NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN ('reserved','running','uncertain','released')),
 lease_until timestamptz NOT NULL, absence_evidence text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(domain_id,installation_id) REFERENCES ac_installation_members(domain_id,id),
 UNIQUE(domain_id,operation_id)
);
CREATE TABLE ac_installation_history (
 sequence bigserial PRIMARY KEY, domain_id uuid NOT NULL REFERENCES ac_installation_domains(id),
 kind text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ac_installation_commands (
 id uuid PRIMARY KEY, principal_id text NOT NULL, payload_digest text NOT NULL, result jsonb NOT NULL
);
CREATE TABLE ac_installation_projects (
 project_id uuid PRIMARY KEY REFERENCES ac_projects(id), domain_id uuid NOT NULL REFERENCES ac_installation_domains(id)
);
CREATE TABLE ac_installation_refreshes (
 id uuid PRIMARY KEY, domain_id uuid NOT NULL REFERENCES ac_installation_domains(id),
 installation_id uuid NOT NULL, epoch integer NOT NULL, account_id uuid NOT NULL REFERENCES ac_accounts(id),
 state text NOT NULL CHECK(state IN ('claimed','finished','uncertain')),
 FOREIGN KEY(domain_id,installation_id) REFERENCES ac_installation_members(domain_id,id)
);
-- A lost refresh ACK retains its account exclusion until trusted reconciliation.
CREATE UNIQUE INDEX ac_installation_refresh_account_active ON ac_installation_refreshes(account_id) WHERE state<>'finished';
CREATE TABLE ac_installation_accounts (
 account_id uuid PRIMARY KEY REFERENCES ac_accounts(id), domain_id uuid NOT NULL REFERENCES ac_installation_domains(id)
);
