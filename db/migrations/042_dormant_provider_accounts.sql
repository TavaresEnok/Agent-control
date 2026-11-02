-- Real-provider metadata is admitted only as dormant configuration. This does
-- not activate authentication, credentials, workers, inference or quota use.
ALTER TABLE ac_accounts DROP CONSTRAINT ac_accounts_mode_check;
ALTER TABLE ac_accounts ADD CONSTRAINT ac_accounts_mode_check CHECK(mode IN ('synthetic','subscription_cli','api'));
ALTER TABLE ac_accounts ADD CONSTRAINT ac_accounts_dormant_check CHECK(mode='synthetic' OR NOT enabled);

-- The account row lock serializes profile activation with changes to its mode.
CREATE FUNCTION ac_validate_dormant_provider_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_mode text;
BEGIN
 SELECT mode INTO account_mode FROM ac_accounts WHERE id=NEW.account_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND'; END IF;
 IF account_mode<>'synthetic' AND NEW.enabled THEN RAISE EXCEPTION 'PROVIDER_RUNTIME_NOT_ACTIVATED'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_dormant_provider_profile_guard BEFORE INSERT OR UPDATE OF enabled,account_id ON ac_profiles
 FOR EACH ROW EXECUTE FUNCTION ac_validate_dormant_provider_profile();
CREATE FUNCTION ac_validate_dormant_provider_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.mode IS DISTINCT FROM OLD.mode THEN RAISE EXCEPTION 'PROVIDER_ACCOUNT_MODE_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_dormant_provider_mode_guard BEFORE UPDATE OF mode ON ac_accounts
 FOR EACH ROW EXECUTE FUNCTION ac_validate_dormant_provider_mode();
