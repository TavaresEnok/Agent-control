-- Period membership and per-attempt cumulative observation baselines.
CREATE INDEX ac_usage_grants_period ON ac_capacity_grants(context_id,created_at,id) WHERE resource_kind='model';
CREATE INDEX ac_usage_observations_period ON ac_usage_observations(grant_id,observed_at,seq);
