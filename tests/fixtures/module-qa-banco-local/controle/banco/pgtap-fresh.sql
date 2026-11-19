SELECT count(*) = 0
   AND EXISTS (
     SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'items'
       AND column_name = 'revision' AND is_nullable = 'NO'
   )
FROM public.items;
