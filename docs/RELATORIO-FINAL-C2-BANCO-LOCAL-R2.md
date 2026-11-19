# QA de PostgreSQL e pgTAP — revisão de 786e6f0e

1. O instalador fixa `postgresql-16`, `postgresql-client-16` e `libpq5` em `16.15-0ubuntu0.24.04.1` e `postgresql-16-pgtap` em `1.3.2-2`, no snapshot Ubuntu `20261118T000000Z`. A instalação confere a versão dos três pacotes PostgreSQL e a saída de `postgres --version`. O coletor exige `server_version_num = 160015` e pgTAP `1.3.2`. O PostgreSQL lista a versão 16.15 como corrigida para a CVE-2026-14680. [Aviso do PostgreSQL](https://www.postgresql.org/support/security/CVE-2026-14680/) · [Snapshot Ubuntu](https://snapshot.ubuntu.com/ubuntu/20261118T000000Z/)
2. A conexão `qa_reader` prepara o `SELECT` em uma transação somente leitura. Os metadados da consulta preparada confirmam uma única coluna booleana e a saída confirma exatamente uma linha com valor não nulo. Uma segunda conexão, como `qa_admin`, executa `plan`, `ok` e `finish` no banco administrativo `qa_attestation`. Essa sessão recebe apenas o valor validado como literal `TRUE` ou `FALSE`. Apenas uma reprovação confirmada pelo pgTAP produz o achado `QA-BANCO-PGTAP`. [Metadados de consultas preparadas](https://www.postgresql.org/docs/16/view-pg-prepared-statements.html)
3. `qa_reader` recebe a associação a `pg_read_all_data` sem herdar privilégios. A sessão ativa o papel com `SET LOCAL ROLE` e volta a `qa_reader` no `ROLLBACK`. Isso preserva as ACLs de schemas e relações, incluindo os catálogos internos. Os papéis do projeto e de leitura ficam sem `CONNECT` no banco administrativo. [Associação a papéis no PostgreSQL 16](https://www.postgresql.org/docs/16/sql-grant.html)
4. O PostgreSQL interpreta o terminador do `SELECT` no `PREPARE` e o terminador da migração diretamente no `psql`. A fixture de controle aplica a migração que termina em `COMMIT;` seguido de comentário e confirma a coluna nova com um `SELECT` que também termina em `;` seguido de comentário. [Execução de comandos no psql](https://www.postgresql.org/docs/16/app-psql.html)

## Verificação focada

Foram verificadas as assinaturas dos índices Ubuntu `noble` e `noble-updates` para `amd64`, os SHA-256 dos índices e os SHA-256 dos quatro pacotes selecionados. Os binários foram extraídos em uma área temporária, sem instalação de pacotes no host. Os testes usaram um cluster descartável em socket Unix privado, com os dados sintéticos da fixture de controle.

| Caso | Resultado observado |
| --- | --- |
| Booleano `TRUE` | pgTAP aprovou 1/1 |
| Booleano `FALSE` | pgTAP reprovou 1/1 |
| Duas linhas ou duas colunas | Critério escalar inválido, sem julgamento pgTAP |
| Nenhuma linha, `NULL` ou texto | Critério escalar inválido, sem julgamento pgTAP |
| `COMMIT;` seguido de comentário na migração | Migração concluída e coluna confirmada |
| `SELECT` sem `;` e com `;` seguido de comentário de linha ou bloco | pgTAP aprovou 1/1 |
| Privilégios após cada `ROLLBACK` | `current_user` voltou a `qa_reader`, sem `SELECT` nem `INSERT` na tabela da fixture |
| ACLs e acesso ao banco administrativo | ACLs dos schemas e relações idênticas antes e depois. `qa_project` e `qa_reader` sem `CONNECT` no banco administrativo |

`npx tsc --noEmit --skipLibCheck`, `sh -n deploy/modules/qa/banco-local/install.sh` e `git diff --check` passaram. Em `tests/module-qa-banco-local.test.ts`, 11 testes passaram, incluindo o teste com os binários do snapshot. O teste de entrypoint permaneceu desativado porque depende do laboratório e de uma imagem QA atualizada.
