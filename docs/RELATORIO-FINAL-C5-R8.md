# C5 R8 — Atribuição de falhas de migração

O coletor usa o SQLSTATE, a rotina do servidor e a árvore SQL dos quadros de contexto para distinguir uma falha do próprio `SET CONSTRAINTS` de uma falha durante a checagem de alterações anteriores. O diagnóstico usa a transação original. Quando a evidência identifica apenas quem disparou a checagem, o achado é do lote e registra origem entre arquivos indeterminada.

| Fixture sintética | Resultado observado |
| --- | --- |
| Gatilho diferido com três funções SQL na pilha, incluindo sobrecargas com aspas no nome e uma função cujo nome ocupa duas linhas | `22012` atribuído ao lote. O quadro externo identifica a checagem antecipada e a origem permanece indeterminada. |
| `EXECUTE` com uma aspa no fim de um comentário `--` antes de `CONSTRAINTS`, e controle com comentário no fim do comando | `23503` atribuído ao lote nos dois casos, com origem indeterminada. O lexer distingue os delimitadores dos quadros das aspas em comentários, identificadores e literais. |
| `DO` executa outro `DO` com `SET CONSTRAINTS` qualificado em `DEFERRED` | `3F000` atribuído à linha 2, início do `DO` externo. O controle com `IMMEDIATE` e uma FK pendente registra rejeição do lote. |
| `SET LOCAL statement_timeout` seguido de `SET CONSTRAINTS` com esquema ausente | `3F000` atribuído ao `SET CONSTRAINTS` na linha 2. |
| Dois comandos ou dois blocos com os mesmos nomes, e DDL sem cursor do servidor | O achado identifica o arquivo executor. A linha exibida é a referência do arquivo, com indicação explícita de que a posição exata está indisponível. |
| Consulta de latência da fixture | O SHA-256 registrado por `pg_stat_statements` coincide com o hash dos bytes do arquivo medido. |

## Verificação

As fixtures de atribuição conferem uma conexão, um `BEGIN`, uma execução de cada arquivo e um `ROLLBACK`. O ensaio usa PostgreSQL 17.12 efêmero em diretório descartável, com socket Unix privado. Os controles de medição usam Squawk 2.73.0, Dexter 0.6.3 e HypoPG 1.4.1.

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-banco-r3.test.ts` passou com sete testes e zero pulos em modo nativo. A primeira tentativa precisou do `GEM_PATH` do conjunto local de ferramentas para carregar o Dexter.
- `ruby -c deploy/modules/banco/collector.rb` e `git diff --check` passaram.

O coletor e o teste já tinham alterações locais da R8 no início da tarefa. O commit incorpora esse trabalho e os controles adicionais de posição indisponível e nome de função com quebra de linha. A verificação ficou restrita ao arquivo de testes alterado e às checagens estáticas.
