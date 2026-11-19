ALTER TABLE public.items ADD COLUMN revision integer NOT NULL DEFAULT 1;
UPDATE public.items SET payload = 'conteudo-substituido';
