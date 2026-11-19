-- Leitura pontual pelo índice criado na migração.
SELECT id, codigo, valor
FROM pedidos_audit
WHERE codigo = 'COD-00042'
LIMIT 1;
