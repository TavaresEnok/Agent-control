export function insegura(req, db) {
  const nome = req.query.nome;
  const sql = "SELECT id FROM contas WHERE nome = '" + nome + "'";
  return db.query(sql);
}

export function segura(req, db) {
  return db.query('SELECT id FROM contas WHERE id = $1', [req.query.id]);
}
