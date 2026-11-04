-- Per-profile reasons for a model wait that found nobody eligible.
-- Nullable on purpose: existing rows stay NULL and are not rewritten.
-- A CHECK cannot contain a subquery (jsonb_array_elements in the constraint
-- fails with "cannot use subquery in check constraint"). plpgsql is not
-- inlined into the CHECK. The body uses only immutable jsonb operations.
CREATE FUNCTION ac_valid_capacity_exclusions(exclusions jsonb) RETURNS boolean
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
      'not_synthetic','ineligible','quota_exhausted','quota_unknown') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;
ALTER TABLE ac_capacity_waits ADD COLUMN exclusions jsonb;
ALTER TABLE ac_capacity_waits ADD CONSTRAINT ac_capacity_waits_exclusions_check
  CHECK (ac_valid_capacity_exclusions(exclusions));
