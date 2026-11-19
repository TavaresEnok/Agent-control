-- Invariante válido nos esquemas histórico e atualizado.
SELECT count(*) = 1
   AND count(*) FILTER (WHERE item_code = 31001 AND payload = 'dado-sintetico') = 1
FROM public.items;
