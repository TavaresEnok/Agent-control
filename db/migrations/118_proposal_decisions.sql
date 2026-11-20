-- One durable decision per (context, proposal revision). The decision is written before any execution exists,
-- so a crash between the decision and the execution is recoverable, and concurrent approvals, discards or
-- repeats after a lost response all read the same row. The execution intent id is fixed by the decision.
CREATE TABLE ac_proposal_decisions(
 context_id uuid NOT NULL REFERENCES ac_contexts,
 revision integer NOT NULL CHECK(revision>0),
 proposal_digest text NOT NULL CHECK(proposal_digest ~ '^[0-9a-f]{64}$'),
 decision text NOT NULL CHECK(decision IN ('approved','discarded')),
 source text NOT NULL CHECK(source IN ('manual','auto','api','legacy')),
 intent_id uuid,
 decided_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(context_id,revision),
 CHECK((decision='approved')=(intent_id IS NOT NULL))
);
CREATE UNIQUE INDEX ac_proposal_decisions_intent ON ac_proposal_decisions(intent_id) WHERE intent_id IS NOT NULL;
CREATE FUNCTION ac_reject_proposal_decision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PROPOSAL_DECISION_IMMUTABLE'; END; $$;
CREATE TRIGGER ac_proposal_decision_immutable BEFORE UPDATE OR DELETE ON ac_proposal_decisions
FOR EACH ROW EXECUTE FUNCTION ac_reject_proposal_decision_change();

-- Decisions made before this table existed: started proposals and discards recorded in the audit trail.
INSERT INTO ac_proposal_decisions(context_id,revision,proposal_digest,decision,source,intent_id,decided_at)
SELECT DISTINCT ON (i.context_id,(i.command->'payload'->>'proposalRevision')::int)
 i.context_id,(i.command->'payload'->>'proposalRevision')::int,i.command->'payload'->>'proposalDigest','approved','legacy',i.id,i.created_at
FROM ac_intents i
WHERE i.parent_intent_id IS NULL AND i.command->>'action'='plan.start' AND i.command->'payload'->>'workflow'='managed-synthetic-v1'
 AND (i.command->'payload'->>'proposalRevision') ~ '^[0-9]+$' AND (i.command->'payload'->>'proposalRevision')::int>0
 AND (i.command->'payload'->>'proposalDigest') ~ '^[0-9a-f]{64}$'
ORDER BY i.context_id,(i.command->'payload'->>'proposalRevision')::int,i.created_at,i.id
ON CONFLICT DO NOTHING;
INSERT INTO ac_proposal_decisions(context_id,revision,proposal_digest,decision,source,intent_id,decided_at)
SELECT DISTINCT ON (a.context_id,(a.detail->>'revision')::int)
 a.context_id,(a.detail->>'revision')::int,p.digest,'discarded','legacy',NULL,a.created_at
FROM ac_audit a JOIN ac_manager_plans p ON p.context_id=a.context_id AND p.revision=(a.detail->>'revision')::int
WHERE a.kind='proposal.discarded' AND a.context_id IS NOT NULL AND (a.detail->>'revision') ~ '^[0-9]+$'
ORDER BY a.context_id,(a.detail->>'revision')::int,a.created_at,a.id
ON CONFLICT DO NOTHING;

-- Every other way of starting a proposal (API, panel, automation) goes through the same decision: a first start
-- records it, a second start of the same revision with another intent, or after a discard, is refused.
CREATE FUNCTION ac_record_proposal_start() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rev integer; dig text; existing ac_proposal_decisions%ROWTYPE;
BEGIN
 IF NEW.parent_intent_id IS NOT NULL OR NEW.command->>'action'<>'plan.start'
  OR COALESCE(NEW.command->'payload'->>'workflow','')<>'managed-synthetic-v1' THEN RETURN NEW; END IF;
 -- Only well-formed proposal starts are decisions; the command contract rejects anything else before it reaches here.
 IF COALESCE(NEW.command->'payload'->>'proposalRevision','') !~ '^[0-9]+$' OR COALESCE(NEW.command->'payload'->>'proposalDigest','') !~ '^[0-9a-f]{64}$' THEN RETURN NEW; END IF;
 rev:=(NEW.command->'payload'->>'proposalRevision')::int; dig:=NEW.command->'payload'->>'proposalDigest';
 IF rev<=0 THEN RETURN NEW; END IF;
 INSERT INTO ac_proposal_decisions(context_id,revision,proposal_digest,decision,source,intent_id)
 VALUES(NEW.context_id,rev,dig,'approved','api',NEW.id) ON CONFLICT(context_id,revision) DO NOTHING;
 SELECT * INTO existing FROM ac_proposal_decisions WHERE context_id=NEW.context_id AND revision=rev;
 IF existing.proposal_digest<>dig THEN RAISE EXCEPTION 'PROPOSAL_DIGEST_CONFLICT'; END IF;
 IF existing.decision<>'approved' OR existing.intent_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'PROPOSAL_ALREADY_DECIDED'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ac_proposal_start_decision BEFORE INSERT ON ac_intents FOR EACH ROW EXECUTE FUNCTION ac_record_proposal_start();
