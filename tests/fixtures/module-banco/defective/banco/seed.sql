INSERT INTO public.items (item_code, payload)
SELECT n, repeat('dado-sintetico', 16)
FROM generate_series(1, 40000) AS n;
