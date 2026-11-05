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
      'profile_missing','access_removed','account_disabled','profile_disabled','model_disabled_by_policy','model_effort_not_in_catalog',
      'not_synthetic','ineligible','quota_exhausted','quota_unknown',
      'quota_rate_limited','authentication_required','provider_unreachable','provider_configuration_error','quota_disabled') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;
