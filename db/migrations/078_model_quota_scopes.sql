-- Scope promotion is conservative: legacy account-only observations never become
-- evidence for another model after a scoped contract has been observed.
ALTER TABLE ac_accounts ADD COLUMN quota_scope_mode text NOT NULL DEFAULT 'account' CHECK(quota_scope_mode IN ('account','model'));
CREATE TABLE ac_model_quota_observations (
 account_id uuid NOT NULL REFERENCES ac_accounts(id),model text NOT NULL CHECK(length(model) BETWEEN 1 AND 100),
 status text NOT NULL CHECK(status IN ('available','exhausted','rate_limited','auth_required','unknown','unreachable','disabled','configuration_error')),
 source text NOT NULL,observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,model),CHECK(expires_at>observed_at)
);
CREATE FUNCTION ac_profile_quota_status(account uuid, model_name text) RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT CASE WHEN q.expires_at IS NULL OR q.expires_at<=clock_timestamp() THEN 'unknown'
  WHEN q.status<>'available' THEN q.status
  WHEN a.quota_scope_mode='account' THEN q.status
  WHEN mq.expires_at IS NULL OR mq.expires_at<=clock_timestamp() THEN 'unknown'
  ELSE mq.status END
 FROM ac_accounts a LEFT JOIN ac_quota_observations q ON q.account_id=a.id
 LEFT JOIN ac_model_quota_observations mq ON mq.account_id=a.id AND mq.model=model_name
 WHERE a.id=account
$$;

-- Extend the persisted closed reason contract together with the TypeScript enum.
CREATE OR REPLACE FUNCTION ac_valid_capacity_exclusions(exclusions jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  index integer;
  element jsonb;
  profile_id text;
  reason text;
BEGIN
  IF exclusions IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(exclusions) <> 'array' THEN
    RETURN false;
  END IF;
  FOR index IN 0 .. jsonb_array_length(exclusions) - 1 LOOP
    element := exclusions -> index;
    IF jsonb_typeof(element) <> 'object' THEN
      RETURN false;
    END IF;
    profile_id := element->>'profileId';
    reason := element->>'reason';
    IF profile_id IS NULL
      OR profile_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN false;
    END IF;
    IF reason IS NULL OR reason NOT IN (
      'profile_missing','access_removed','account_disabled','profile_disabled',
      'not_synthetic','ineligible','quota_exhausted','quota_unknown',
      'quota_rate_limited','authentication_required','provider_unreachable','provider_configuration_error','quota_disabled') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;
