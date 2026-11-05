CREATE TABLE ac_project_environment_revisions (
 project_id uuid NOT NULL REFERENCES ac_projects,
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 filesystem jsonb NOT NULL,
 digest text NOT NULL,
 published_by text NOT NULL,
 published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,revision)
);
CREATE TRIGGER ac_project_environments_immutable BEFORE UPDATE OR DELETE ON ac_project_environment_revisions
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_project_environment_heads (
 project_id uuid PRIMARY KEY REFERENCES ac_projects,
 revision integer NOT NULL,
 FOREIGN KEY(project_id,revision) REFERENCES ac_project_environment_revisions
);
CREATE TABLE ac_project_environment_intents (
 id uuid PRIMARY KEY,principal_id text NOT NULL,payload_digest text NOT NULL,result jsonb NOT NULL
);
CREATE TABLE ac_project_environment_deliveries (
 id uuid PRIMARY KEY,intent_id uuid NOT NULL REFERENCES ac_project_environment_intents
);
CREATE TABLE ac_project_environment_bindings (
 intent_id uuid PRIMARY KEY REFERENCES ac_execution_contracts(intent_id),
 project_id uuid NOT NULL,revision integer NOT NULL,environment_id text NOT NULL,
 contract_digest text NOT NULL,
 FOREIGN KEY(project_id,revision) REFERENCES ac_project_environment_revisions
);
CREATE TRIGGER ac_project_environment_bindings_immutable BEFORE UPDATE OR DELETE ON ac_project_environment_bindings
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();
CREATE TABLE ac_project_environment_sources (
 parent_intent_id uuid PRIMARY KEY REFERENCES ac_intents,
 project_id uuid NOT NULL,revision integer NOT NULL,source_commit text NOT NULL CHECK(source_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 FOREIGN KEY(project_id,revision) REFERENCES ac_project_environment_revisions
);
CREATE TRIGGER ac_project_environment_sources_immutable BEFORE UPDATE OR DELETE ON ac_project_environment_sources
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();

-- Startup fixed-task configuration supplies an immutable scope for synthetic
-- commands which intentionally have no caller-provided writePaths.
CREATE TABLE ac_project_environment_write_scopes (
 intent_id uuid PRIMARY KEY REFERENCES ac_intents,
 snapshot jsonb NOT NULL CHECK(snapshot->>'source'='remote-fixed-task' AND snapshot->>'schemaVersion'='1' AND jsonb_typeof(snapshot->'writePaths')='array'),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$')
);
CREATE TRIGGER ac_project_environment_write_scopes_immutable BEFORE UPDATE OR DELETE ON ac_project_environment_write_scopes
 FOR EACH ROW EXECUTE FUNCTION ac_reject_policy_mutation();

CREATE FUNCTION ac_environment_contract_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head integer; conf jsonb; env jsonb; paths jsonb; path text; unit jsonb;
BEGIN
 PERFORM id FROM ac_projects WHERE id=NEW.project_id FOR SHARE;
 SELECT revision INTO head FROM ac_project_environment_heads WHERE project_id=NEW.project_id FOR SHARE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT snapshot INTO conf FROM ac_project_environment_revisions WHERE project_id=NEW.project_id AND revision=head;
 SELECT item INTO env FROM jsonb_array_elements(conf->'environments') item WHERE item->>'targetRef'=NEW.target_ref;
 IF env IS NULL THEN RAISE EXCEPTION 'PROJECT_ENVIRONMENT_TARGET_FORBIDDEN'; END IF;
 SELECT command->'payload'->'writePaths' INTO paths FROM ac_intents WHERE id=NEW.intent_id;
 IF paths IS NULL THEN
  SELECT item INTO unit FROM ac_intents i JOIN ac_managed_executions x ON x.parent_intent_id=i.parent_intent_id,
   LATERAL jsonb_array_elements(x.recipe->'units') item WHERE i.id=NEW.intent_id AND item->>'intentId'=NEW.intent_id::text;
  paths=unit->'writePaths';
 END IF;
 IF paths IS NULL AND EXISTS(SELECT 1 FROM ac_intents WHERE id=NEW.intent_id AND command->'payload'->>'workflow'='engineering-synthetic-v1') THEN
  SELECT snapshot->'writePaths' INTO paths FROM ac_project_environment_write_scopes WHERE intent_id=NEW.intent_id;
 END IF;
 IF paths IS NULL OR jsonb_typeof(paths)<>'array' THEN RAISE EXCEPTION 'PROJECT_ENVIRONMENT_WRITE_SCOPE_REQUIRED'; END IF;
 FOR path IN SELECT jsonb_array_elements_text(paths) LOOP
  IF path ~ '(^|/)(\.|\.\.|\.git|\.ai)(/|$)' OR path LIKE '/%' OR position(chr(92) in path)>0 OR path LIKE '%//%' OR path LIKE '%/' OR path ~ '[[:cntrl:]]' THEN
   RAISE EXCEPTION 'PROJECT_ENVIRONMENT_DIRECTORY_FORBIDDEN';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(env->'authorizedDirectories') scope
    WHERE path=scope OR left(path,length(scope)+1)=scope||'/') THEN
   RAISE EXCEPTION 'PROJECT_ENVIRONMENT_DIRECTORY_FORBIDDEN';
  END IF;
 END LOOP;
 INSERT INTO ac_project_environment_bindings VALUES(NEW.intent_id,NEW.project_id,head,env->>'id',NEW.digest);
 RETURN NEW;
END $$;
CREATE TRIGGER ac_environment_contract_binding AFTER INSERT ON ac_execution_contracts
 FOR EACH ROW EXECUTE FUNCTION ac_environment_contract_binding();

CREATE FUNCTION ac_environment_require_current(intent uuid,project uuid,local_delivery boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE head integer; binding ac_project_environment_bindings%ROWTYPE; env jsonb;
BEGIN
 PERFORM id FROM ac_projects WHERE id=project FOR SHARE;
 SELECT revision INTO head FROM ac_project_environment_heads WHERE project_id=project FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT b.* INTO binding FROM ac_project_environment_bindings b JOIN ac_execution_contracts x ON x.intent_id=b.intent_id
  WHERE b.intent_id=intent AND b.project_id=project AND b.contract_digest=x.digest;
 IF NOT FOUND OR binding.revision<>head THEN RAISE EXCEPTION 'PROJECT_ENVIRONMENT_BINDING_REQUIRED'; END IF;
 IF local_delivery THEN
  SELECT item INTO env FROM ac_project_environment_revisions r,LATERAL jsonb_array_elements(r.snapshot->'environments') item
   WHERE r.project_id=project AND r.revision=head AND item->>'id'=binding.environment_id;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(env->'destinations') dest WHERE dest->>'kind'='local_repository') THEN
   RAISE EXCEPTION 'PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN';
  END IF;
 END IF;
END $$;
CREATE FUNCTION ac_environment_grant_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role IN ('programmer','reviewer','qa','judge') AND NEW.state IN ('reserved','running','uncertain') THEN
  PERFORM ac_environment_require_current(NEW.intent_id,NEW.project_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_environment_grant_admission BEFORE INSERT OR UPDATE ON ac_capacity_grants
 FOR EACH ROW EXECUTE FUNCTION ac_environment_grant_admission();
CREATE FUNCTION ac_environment_local_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a ac_artifacts%ROWTYPE; target text;
BEGIN
 SELECT * INTO a FROM ac_artifacts WHERE id=NEW.artifact_id;
 PERFORM ac_environment_require_current(a.intent_id,a.project_id,true);
 SELECT x.target_ref INTO target FROM ac_execution_contracts x WHERE x.intent_id=a.intent_id;
 IF EXISTS(SELECT 1 FROM ac_project_environment_heads WHERE project_id=a.project_id) AND target IS DISTINCT FROM NEW.target_ref THEN
  RAISE EXCEPTION 'PROJECT_ENVIRONMENT_TARGET_FORBIDDEN';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_environment_local_delivery BEFORE INSERT ON ac_integration_intents
 FOR EACH ROW EXECUTE FUNCTION ac_environment_local_delivery();
