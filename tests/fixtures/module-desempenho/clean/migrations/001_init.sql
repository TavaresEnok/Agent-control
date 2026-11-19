CREATE TABLE pedidos_audit (
  id integer PRIMARY KEY,
  codigo text NOT NULL,
  observacao text NOT NULL,
  valor numeric(10, 2) NOT NULL
);

CREATE INDEX idx_pedidos_audit_codigo ON pedidos_audit (codigo);

INSERT INTO pedidos_audit (id, codigo, observacao, valor)
SELECT
  g,
  'COD-' || lpad(g::text, 5, '0'),
  'registro padrao ' || g::text,
  (g % 500) + 10.50
FROM generate_series(1, 50000) AS g;

ANALYZE pedidos_audit;
