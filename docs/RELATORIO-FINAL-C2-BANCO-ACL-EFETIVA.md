# Privilégios efetivos da asserção de QA do banco local

Antes de preparar a asserção, o coletor verifica, em uma transação administrativa somente leitura, os privilégios do papel temporário já configurado. A consulta usa o mesmo recorte por proprietário, schema e tipo de relação que orienta as concessões da fixture. Para relações de usuário fora desse recorte, verifica se o papel tem `USAGE` no schema junto com `SELECT` na relação ou em alguma de suas colunas. As funções de privilégios do PostgreSQL incluem as concessões a `PUBLIC`. A consulta usa somente metadados e preserva as relações de catálogo criadas pelo `initdb`, identificadas pelo intervalo de OIDs reservado no PostgreSQL 16. [Funções de privilégios](https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE) · [Intervalos de OIDs no PostgreSQL 16](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/include/access/transam.h#L145-L175)

Se a verificação encontra acesso externo ao recorte ou não confirma o isolamento, a etapa registra cobertura inconclusiva como `skipped`, sem enviar a asserção ao PostgreSQL nem acionar o pgTAP. A limpeza remove o papel temporário e suas concessões. As ACLs preexistentes permanecem vigentes. Quando o escopo é confirmado, a sessão de leitura entrega apenas o booleano validado ao pgTAP no banco separado `qa_attestation`.

## Verificação dirigida

O teste usou PostgreSQL 16.15 e pgTAP 1.3.2 em um cluster descartável com socket Unix privado e fixtures sintéticas. As variantes de ACL usaram somente consultas de metadados sobre as relações artificiais e a asserção nominal `SELECT TRUE`.

| Caso | Resultado observado |
| --- | --- |
| Controle normal | A fixture e a asserção escalar passaram no pgTAP. |
| `SELECT` a `PUBLIC` na tabela administrativa em `public` | Os metadados confirmaram `USAGE` e `SELECT` efetivos. A asserção ficou inconclusiva e o pgTAP ficou sem execução. |
| `SELECT (id)` a `PUBLIC` sem `USAGE` em `qa_interno` | Os metadados confirmaram que somente a coluna tinha concessão de leitura e que o papel carecia de `USAGE`. A asserção nominal passou. |
| `SELECT (id)` a `PUBLIC` com `USAGE` em `qa_interno` | A concessão apenas na coluna foi suficiente para marcar cobertura inconclusiva. A sessão da asserção e o pgTAP ficaram sem execução. |
| Erro ou saída inesperada na verificação | Os testes unitários confirmaram cobertura inconclusiva e remoção do papel temporário. |
| ACLs e isolamento do pgTAP | As ACLs de banco, schema, relação e coluna conferiram antes e depois de cada caso. A comparação normalizou a representação das ACLs padrão dos objetos da fixture. O papel temporário foi removido em todos os casos e carecia de `CONNECT` em `qa_attestation` durante a verificação. |

`npx tsc --noEmit --skipLibCheck`, `node --check` nos dois módulos alterados e `git diff --check` passaram. Em `tests/module-qa-banco-local.test.ts`, 14 testes passaram, incluindo o teste com PostgreSQL e pgTAP. O teste de entrypoint ficou desativado por depender do laboratório.
