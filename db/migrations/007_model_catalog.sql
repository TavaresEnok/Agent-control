CREATE TABLE ac_model_catalog(provider text NOT NULL, model text NOT NULL,
 efforts text[] NOT NULL CHECK(cardinality(efforts)>0), roles text[] NOT NULL CHECK(cardinality(roles)>0),
 source text NOT NULL, PRIMARY KEY(provider,model));
