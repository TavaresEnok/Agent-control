-- Agregação repetida para cada janela do relatório, sobre os dados da migração.
SELECT count(*), max(md5(observacao || rodada::text))
FROM pedidos_audit
CROSS JOIN generate_series(1, 64) AS janelas(rodada)
WHERE observacao LIKE '%urgente%';
