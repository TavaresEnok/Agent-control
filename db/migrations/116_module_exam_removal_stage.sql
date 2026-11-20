-- Passive module-exam recovery (modules 2 to 9): a legacy v1 retirement journal was written before any DELETE and
-- proves nothing about how the tools container went away. After this supervisor's DELETE of the verified Created
-- container is confirmed, the still-prepared v1 journal may be promoted, once, to the v2 `tools_removed` stage that
-- the supervisor signs. Every field of the v1 binding is kept; only the version, the stage, the evidence digest and
-- the removal signature are added. Any other change stays immutable; the signature is verified by the supervisor.
CREATE OR REPLACE FUNCTION ac_guard_native_terminal_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NATIVE_TERMINAL_RETIREMENT_IMMUTABLE'; END IF;
 IF NEW.job_id IS NOT DISTINCT FROM OLD.job_id AND OLD.state='prepared' AND NEW.state='prepared' AND NEW.proof IS NULL AND
    OLD.binding->>'kind'='native-module-exam-never-started-retired' AND OLD.binding->'schemaVersion'='1'::jsonb AND
    NOT (OLD.binding ? 'stage') AND NOT (OLD.binding ? 'toolsEvidenceDigest') AND NOT (OLD.binding ? 'removalSignature') AND
    NEW.binding->'schemaVersion'='2'::jsonb AND NEW.binding->>'stage'='tools_removed' AND
    jsonb_typeof(NEW.binding->'toolsEvidenceDigest')='string' AND jsonb_typeof(NEW.binding->'removalSignature')='string' AND
    (NEW.binding - ARRAY['schemaVersion','stage','toolsEvidenceDigest','removalSignature']) = (OLD.binding - 'schemaVersion') THEN
  RETURN NEW;
 END IF;
 IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.binding IS DISTINCT FROM OLD.binding OR
    OLD.state <> 'prepared' OR NEW.state <> 'removed' THEN
  RAISE EXCEPTION 'NATIVE_TERMINAL_RETIREMENT_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
