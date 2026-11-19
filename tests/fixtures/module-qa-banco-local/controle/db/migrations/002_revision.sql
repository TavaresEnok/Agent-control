BEGIN;
ALTER TABLE public.items ADD COLUMN revision integer NOT NULL DEFAULT 1;
COMMIT; -- Fim da migração.
