# Escopo de herança e partições no QA do banco local

Antes de preparar a asserção, a sessão administrativa somente leitura percorre os vínculos de `pg_catalog.pg_inherits` a partir das relações que pertencem à fixture. A consulta segue vínculos diretos e indiretos de herança e particionamento. Qualquer descendente fora da fixture torna o escopo inconclusivo, mesmo quando o papel de leitura carece de `USAGE` no schema e de `SELECT` no descendente. A checagem considera toda a hierarquia registrada no catálogo, inclusive vínculos com desanexação pendente. [Catálogo `pg_inherits` do PostgreSQL 16](https://www.postgresql.org/docs/16/catalog-pg-inherits.html) · [Herança no PostgreSQL 16](https://www.postgresql.org/docs/16/ddl-inherit.html)

A confirmação também verifica as ACLs efetivas para relações fora da fixture. Se o escopo ficar inconclusivo, o coletor registra a etapa como `skipped`, pula a preparação e a execução da asserção e remove o papel temporário. O pgTAP só recebe o booleano de uma asserção executada com escopo confirmado.

## Verificação dirigida

O teste usou PostgreSQL 16.15 e pgTAP 1.3.2 em um cluster descartável com socket Unix privado. Cada hierarquia começou com duas linhas artificiais. As duas variantes usaram `SELECT count(*) = 2` sobre a tabela pai. O teste acrescentou uma terceira linha artificial no descendente externo e repetiu a mesma contagem após remover o vínculo.

| Cenário | Resultado |
| --- | --- |
| Hierarquia inteira na fixture | A contagem nominal passou com herança e particionamento. |
| Neto herdado em schema administrativo | Os metadados confirmaram ausência de `USAGE` e `SELECT` direto. O escopo ficou inconclusivo antes de abrir a sessão de leitura. |
| Partição em schema administrativo | Os metadados confirmaram ausência de `USAGE` e `SELECT` direto. O escopo ficou inconclusivo antes de abrir a sessão de leitura. |
| Vínculo de herança removido e partição desanexada | A mesma contagem voltou a passar em cada hierarquia. |

O teste de regressão reproduziu a falha anterior na variante de herança. Com a correção, confirmou que os dois casos inconclusivos dispensam o pgTAP e removem o papel temporário. As ACLs conferiram antes e depois de cada caso.

`npx tsc --noEmit --skipLibCheck`, `node --check deploy/modules/qa/banco-local/postgres.mjs` e `git diff --check` passaram. Em `tests/module-qa-banco-local.test.ts`, 14 testes passaram, incluindo a integração com PostgreSQL e pgTAP. O teste de entrypoint do laboratório ficou desativado.
