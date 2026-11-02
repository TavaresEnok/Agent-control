-- Cumulative provider-reported counters are not subscription quota balances.
CREATE TABLE ac_usage_observations(
 grant_id uuid NOT NULL REFERENCES ac_capacity_grants, event_id uuid NOT NULL,
 seq bigint NOT NULL CHECK(seq>0), counters jsonb NOT NULL, digest text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(grant_id,event_id), UNIQUE(grant_id,seq));
