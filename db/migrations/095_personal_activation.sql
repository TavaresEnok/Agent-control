-- Personal activation is an explicit installation opt-in. Locked stays the default:
-- a real provider account or profile may be enabled only while mode = 'personal'.
ALTER TABLE ac_accounts DROP CONSTRAINT IF EXISTS ac_accounts_dormant_check;
DROP TRIGGER IF EXISTS ac_dormant_provider_profile_guard ON ac_profiles;
DROP TRIGGER IF EXISTS ac_dormant_provider_mode_guard ON ac_accounts;
DROP FUNCTION IF EXISTS ac_validate_dormant_provider_profile();
DROP FUNCTION IF EXISTS ac_validate_dormant_provider_mode();

CREATE TABLE ac_installation_activation(
  id int PRIMARY KEY CHECK (id = 1),
  mode text NOT NULL CHECK (mode IN ('locked', 'personal'))
);
INSERT INTO ac_installation_activation(id, mode) VALUES (1, 'locked');

CREATE FUNCTION ac_activation_personal() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM ac_installation_activation WHERE id = 1 AND mode = 'personal')
$$;

CREATE FUNCTION ac_guard_real_provider_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ac_activation_personal() AND NEW.mode <> 'synthetic' AND (
    NEW.enabled OR EXISTS (SELECT 1 FROM ac_profiles WHERE account_id = NEW.id AND enabled)
  ) THEN
    RAISE EXCEPTION 'PROVIDER_RUNTIME_NOT_ACTIVATED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ac_personal_provider_activation_guard
  BEFORE INSERT OR UPDATE OF enabled, mode ON ac_accounts
  FOR EACH ROW EXECUTE FUNCTION ac_guard_real_provider_account();

CREATE FUNCTION ac_guard_real_provider_profile() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE account_mode text;
BEGIN
  SELECT mode INTO account_mode FROM ac_accounts WHERE id = NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND'; END IF;
  IF account_mode <> 'synthetic' AND NEW.enabled AND NOT ac_activation_personal() THEN
    RAISE EXCEPTION 'PROVIDER_RUNTIME_NOT_ACTIVATED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ac_personal_provider_profile_guard
  BEFORE INSERT OR UPDATE OF enabled, account_id ON ac_profiles
  FOR EACH ROW EXECUTE FUNCTION ac_guard_real_provider_profile();

-- Returning to locked while a real account is still enabled is the same refusal.
CREATE FUNCTION ac_guard_installation_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode <> 'personal' AND EXISTS (
    SELECT 1 FROM ac_accounts a
    WHERE a.mode <> 'synthetic' AND (
      a.enabled OR EXISTS (SELECT 1 FROM ac_profiles p WHERE p.account_id = a.id AND p.enabled)
    )
  ) THEN
    RAISE EXCEPTION 'PROVIDER_RUNTIME_NOT_ACTIVATED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ac_installation_activation_guard
  BEFORE UPDATE ON ac_installation_activation
  FOR EACH ROW EXECUTE FUNCTION ac_guard_installation_activation();
