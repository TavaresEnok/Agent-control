SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- A coluna continua disponível para clientes antigos.
ALTER TABLE public.items ADD COLUMN display_label text;
