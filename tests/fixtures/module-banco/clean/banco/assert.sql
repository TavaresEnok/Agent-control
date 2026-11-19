SELECT count(*) = 40000
   AND count(*) FILTER (WHERE item_code = 31001 AND payload = repeat('dado-sintetico', 16)) = 1
FROM public.items;
