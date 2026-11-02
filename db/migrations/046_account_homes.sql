-- Private controller-side homes for future authorized authentication; no
-- credentials, mounts or worker activation are recorded or enabled here.
CREATE TABLE ac_account_homes (
 account_id uuid PRIMARY KEY REFERENCES ac_accounts(id),
 project_id uuid NOT NULL REFERENCES ac_projects(id), owner_id text NOT NULL,
 root_path text NOT NULL, root_device text NOT NULL, root_inode text NOT NULL,
 home_device text NOT NULL, home_inode text NOT NULL, owner_uid text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(home_device,home_inode),
 CHECK(root_device ~ '^[0-9]+$' AND root_inode ~ '^[0-9]+$' AND
       home_device ~ '^[0-9]+$' AND home_inode ~ '^[0-9]+$' AND owner_uid ~ '^[0-9]+$')
);
CREATE TRIGGER ac_account_homes_immutable BEFORE UPDATE OR DELETE ON ac_account_homes
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
