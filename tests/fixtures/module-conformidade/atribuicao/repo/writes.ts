const payload: string | keyof
  { synthetic: number } = syntheticRow.cpf;
logger.info(payload);
const params = [payload, syntheticRow.email];
db.query("/* SYNTHETIC_SQL */ INSERT INTO synthetic (cpf) VALUES ($1)", params);
db.query("WITH src(v) AS (VALUES ($1)) INSERT INTO synthetic (cpf) SELECT v FROM src", [syntheticRow.email]);
db.query("WITH src(tag, v) AS (VALUES ($1, $2)) INSERT INTO synthetic (cpf) SELECT v FROM src", params);
db.query("WITH src(tag, v) AS (VALUES ($1, $2)) INSERT INTO synthetic (tag) SELECT tag FROM src", ["PUBLIC", payload]);
db.query("INSERT INTO synthetic (tag) VALUES ('SYNTHETIC_SQL ? $1')", () => syntheticRow.cpf);
db.query("INSERT INTO synthetic (tag) VALUES ('SYNTHETIC_SQL') /* $1 */", () => syntheticRow.cpf);
db.query("INSERT INTO synthetic (tag) VALUES ($1)", ["PUBLIC", syntheticRow.cpf]);
db.query("SELECT cpf FROM synthetic WHERE cpf = $1", [syntheticRow.cpf]);
db.query("UPDATE synthetic SET tag = ? WHERE cpf = ?", ["PUBLIC", payload]);
db.query("UPDATE synthetic SET tag = :tag WHERE cpf = :predicate", {tag: payload, predicate: "PUBLIC"});
db.query("UPDATE synthetic SET tag = :tag WHERE cpf = :predicate", {tag: "PUBLIC", predicate: payload});
db.query("INSERT INTO synthetic (tag) VALUES ($2)", ["PUBLIC", payload], () => syntheticRow.cpf);

declare const syntheticRow: {cpf: string; email: string};
declare const logger: {info(value: unknown): void};
declare const db: {query(command: string, ...args: unknown[]): void};
export {};
