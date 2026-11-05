-- Additive lab migration. Cezar remains sole owner of graph progression.
CREATE TABLE ac_workflow_runtime_instances(
 project_id uuid NOT NULL REFERENCES ac_projects,
 instance_id uuid NOT NULL,
 build_id text NOT NULL CHECK(build_id ~ '^[A-Za-z0-9._-]{1,80}$'),
 executable_digest text NOT NULL CHECK(executable_digest ~ '^[a-f0-9]{64}$'),
 runtime_digest text NOT NULL CHECK(runtime_digest ~ '^[a-f0-9]{64}$'),
 process_id integer NOT NULL CHECK(process_id>0),
 process_start text NOT NULL CHECK(process_start ~ '^[0-9]+$'),
 protocol text NOT NULL CHECK(protocol='cezar-frozen-graph-generation-v1'),
 workflow_digests jsonb NOT NULL CHECK(jsonb_typeof(workflow_digests)='array'),
 lease_until timestamptz NOT NULL,
 PRIMARY KEY(project_id,instance_id),
 CHECK(build_id='cezar-'||left(runtime_digest,32)));
CREATE TABLE ac_workflow_runtime_defaults(
 project_id uuid PRIMARY KEY REFERENCES ac_projects,
 build_id text NOT NULL CHECK(build_id ~ '^[A-Za-z0-9._-]{1,80}$'));
CREATE TABLE ac_workflow_generations(
 intent_id uuid NOT NULL REFERENCES ac_intents,
 generation integer NOT NULL CHECK(generation>=0),
 predecessor integer,
 build_id text NOT NULL CHECK(build_id ~ '^[A-Za-z0-9._-]{1,80}$'),
 state text NOT NULL CHECK(state IN ('active','reconciling','retained','released')),
 request_id uuid UNIQUE,
 request_digest text CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 workflow_digest text NOT NULL CHECK(workflow_digest ~ '^[a-f0-9]{64}$'),
 continuation jsonb NOT NULL CHECK(octet_length(continuation::text)<=16384),
 successor_instance uuid,
 successor_epoch bigint,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(intent_id,generation),
 FOREIGN KEY(intent_id,predecessor) REFERENCES ac_workflow_generations(intent_id,generation),
 CHECK((generation=0 AND predecessor IS NULL AND request_id IS NULL) OR
       (generation>0 AND predecessor=generation-1 AND request_id IS NOT NULL AND successor_instance IS NOT NULL AND successor_epoch>0)));
CREATE UNIQUE INDEX ac_workflow_generation_current ON ac_workflow_generations(intent_id)
 WHERE state IN ('active','reconciling');
CREATE INDEX ac_workflow_generation_retention ON ac_workflow_generations(build_id,state);
CREATE FUNCTION ac_guard_workflow_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WORKFLOW_GENERATION_IMMUTABLE'; END IF;
 IF ROW(NEW.intent_id,NEW.generation,NEW.predecessor,NEW.build_id,NEW.request_id,NEW.request_digest,NEW.workflow_digest,NEW.continuation,NEW.successor_instance,NEW.successor_epoch,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.intent_id,OLD.generation,OLD.predecessor,OLD.build_id,OLD.request_id,OLD.request_digest,OLD.workflow_digest,OLD.continuation,OLD.successor_instance,OLD.successor_epoch,OLD.created_at)
 OR NOT (NEW.state=OLD.state OR (OLD.state='active' AND NEW.state='retained') OR (OLD.state='reconciling' AND NEW.state='active') OR (OLD.state='retained' AND NEW.state='released'))
 THEN RAISE EXCEPTION 'WORKFLOW_GENERATION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_workflow_generation_guard BEFORE UPDATE OR DELETE ON ac_workflow_generations
 FOR EACH ROW EXECUTE FUNCTION ac_guard_workflow_generation();
CREATE FUNCTION ac_guard_workflow_runtime_instance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.project_id,NEW.instance_id,NEW.build_id,NEW.executable_digest,NEW.runtime_digest,NEW.process_id,NEW.process_start,NEW.protocol,NEW.workflow_digests)
 IS DISTINCT FROM ROW(OLD.project_id,OLD.instance_id,OLD.build_id,OLD.executable_digest,OLD.runtime_digest,OLD.process_id,OLD.process_start,OLD.protocol,OLD.workflow_digests)
 THEN RAISE EXCEPTION 'WORKFLOW_RUNTIME_INSTANCE_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_workflow_runtime_instance_guard BEFORE UPDATE ON ac_workflow_runtime_instances
 FOR EACH ROW EXECUTE FUNCTION ac_guard_workflow_runtime_instance();
