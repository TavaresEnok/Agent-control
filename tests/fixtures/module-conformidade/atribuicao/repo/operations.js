logger.info(syntheticRow[`cpf`]);
logger.info(syntheticRow["c\u0070f"]);
logger.info(["cpf"], "SYNTHETIC_JS");
logger.info(`SYNTHETIC_JS ${(() => {
  if (flag) {}
  /logger.info(syntheticRow.cpf)/.test("SYNTHETIC_REGEX");
  return "PUBLIC";
})()}`);
logger.info(`SYNTHETIC_JS ${/}/.test("}") ? syntheticRow["email"] : "PUBLIC"}`);
logger.info(() => syntheticRow.cpf);
const example = "logger.info(syntheticRow.cpf)";
// logger.info(syntheticRow.cpf);
/* db.query("INSERT INTO synthetic (cpf) VALUES ($1)", [syntheticRow.cpf]); */
const callbackObject = { info(cpf) { return cpf; } };
const payload = syntheticRow.email;
{
  const tag = "SYNTHETIC_JS" +
    "VALUE", payload = "PUBLIC";
  fetch(url, payload);
}
fetch(url, payload);
function exampleHandler(payload) {
  logger.info(payload);
}
localStorage.setItem(syntheticRow.cpf, "PUBLIC");
localStorage.setItem("synthetic-key", payload);
localStorage.setItem("synthetic-key", () => syntheticRow.cpf);
localStorage.setItem("synthetic-key", { tag: "PUBLIC", callback: () => syntheticRow.cpf });
