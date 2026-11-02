CREATE TABLE ac_plan_cancellations(
 intent_id uuid PRIMARY KEY REFERENCES ac_intents,
 context_id uuid NOT NULL REFERENCES ac_contexts,
 requested_by text NOT NULL,
 plan_revision integer NOT NULL,
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','confirmed')),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 confirmed_at timestamptz,
 CHECK((state='confirmed')=(confirmed_at IS NOT NULL))
);
