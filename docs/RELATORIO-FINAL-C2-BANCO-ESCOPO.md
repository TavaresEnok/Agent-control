# QA banco-local — escopo das assertivas SQL

A preparação da assertiva usa `psql -c '\bind' -c 'PREPARE …'` em uma sessão somente leitura. O `\bind` seleciona o protocolo estendido para o comando seguinte. O PostgreSQL aplica o limite de uma instrução na mensagem `Parse` antes da execução. A consulta dos metadados lê os OIDs em `pg_prepared_statements.result_types` e a assertiva é executada uma vez. O coletor aceita somente o OID `16` como único tipo de coluna e uma única linha com `t` ou `f`. O pgTAP recebe o literal `TRUE` ou `FALSE` e emite o resultado em outra conexão, no banco `qa_attestation`. [psql](https://www.postgresql.org/docs/16/app-psql.html) · [Protocolo estendido](https://www.postgresql.org/docs/16/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY) · [Metadados da preparação](https://www.postgresql.org/docs/16/view-pg-prepared-statements.html)

Cada assertiva cria um papel de leitura temporário, sem associação a outros papéis, com `CONNECT` somente no banco medido. O catálogo de proprietários delimita `USAGE` aos schemas de `qa_project` e `SELECT` às tabelas comuns e particionadas, views e views materializadas de `qa_project` nesses schemas. O schema `public` padrão entra no escopo quando `pg_database_owner` o possui e `qa_project` é dono do banco. As permissões de fábrica dos catálogos mantêm disponível a consulta nominal a `information_schema.columns`. Ao fim da leitura, inclusive em caso de falha, o coletor revoga as concessões com `DROP OWNED` e remove o papel. [Papel `pg_database_owner`](https://www.postgresql.org/docs/16/predefined-roles.html) · [Revogação com `DROP OWNED`](https://www.postgresql.org/docs/16/sql-drop-owned.html)

## Verificação dirigida

O teste usou os binários e as bibliotecas fornecidos do PostgreSQL 16.15 e pgTAP 1.3.2 em um cluster descartável com socket Unix privado e fixtures sintéticas.

| Verificação | Resultado observado |
| --- | --- |
| `\bind` com parâmetro nominal | O servidor recebeu o valor vinculado e retornou `t`. |
| Assertivas escalares | `TRUE` aprovou e `FALSE` reprovou no pgTAP. Zero linhas, múltiplas linhas ou colunas, `NULL` e texto foram classificados como inválidos. Foram aceitos terminadores seguidos de comentário e ponto e vírgula dentro de literal. |
| Dados e restauração | A consulta confirmou a coluna nova no banco vazio. O invariante histórico aprovou no banco de origem, após `pg_dump` e `pg_restore`, e após a última migração. |
| ACLs durante a leitura | `pg_database`, `pg_namespace`, `pg_class` e `pg_auth_members` confirmaram as concessões previstas, sem associação a outros papéis, com `CONNECT` apenas no banco medido e sem `TEMP`. As verificações efetivas confirmaram ausência de escrita na tabela da fixture e de leitura na tabela administrativa e na sequência. |
| Revogação | Os privilégios efetivos voltaram ao estado inicial depois de cada assertiva e o papel temporário foi removido. A comparação normalizou uma ACL padrão implícita e sua representação explícita para as relações e schemas da fixture. O teste unitário verificou a revogação quando a leitura falha. |

`npx tsc --noEmit --skipLibCheck`, `node --check deploy/modules/qa/banco-local/postgres.mjs` e `git diff --check` passaram. Em `tests/module-qa-banco-local.test.ts`, 12 testes passaram, incluindo o dirigido ao PostgreSQL. O teste de entrypoint ficou desativado por depender do laboratório, fora do escopo da ordem.
