SELECT count(*), max(md5(observacao))
FROM pedidos_audit
WHERE observacao LIKE '%urgente%';
