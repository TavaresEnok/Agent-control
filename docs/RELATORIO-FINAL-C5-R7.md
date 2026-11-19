# C5 R7 — Diagnóstico PostgreSQL de restrições

O coletor usa o SQLSTATE, a rotina do servidor, a árvore do comando e a
pilha da execução original para distinguir falhas do próprio
`SET CONSTRAINTS` de rejeições durante a checagem diferida. O diagnóstico
cobre esquema ou constraint inexistente, constraint não diferível,
referência a outro catálogo e falta de acesso ao esquema. O lexer do
PostgreSQL delimita o SQL dos quadros da pilha antes da análise da árvore.
O relatório registra a linha de início do comando ou do bloco `DO`
quando ela pode ser determinada.

A prova de atribuição de FK diferida aceita `text` e `uuid` sem
qualificação com o `search_path` inicial do coletor. O `pg_catalog`
implícito é pesquisado antes de `public`. A atribuição exige o diagnóstico
original de FK, uma tabela criada no lote dentro do subconjunto
declarativo e um único arquivo com inserções na tabela indicada.

## Provas

| Controle sintético | Resultado |
| --- | --- |
| `SET CONSTRAINTS` direto, em `DO` e em `EXECUTE` | `3F000` atribuído ao arquivo executor. Os controles para constraint ausente, não diferível, catálogo externo e falta de acesso emitiram respectivamente `42704`, `42809`, `0A000` e `42501`. |
| Cursor de outro comando, mensagem com `SET CONSTRAINTS`, aspas e comentários com texto de quadros SQL | O cursor localizou o comando que falhou. As mensagens e os comentários preservaram a classificação do executor. |
| Checagem diferida por `DO`, erro de esquema dentro de um gatilho e arquivo misto sem cursor | Rejeição do lote com origem indeterminada. No arquivo misto, o achado registra apenas a possibilidade de checagem antecipada. |
| FK composta por `text` e `uuid` com domínios homônimos em `public` | `23503` atribuído ao único arquivo de dados no `COMMIT` e na checagem antecipada. Dois escritores, mudança de `search_path` e tipo explícito de `public` mantiveram a origem indeterminada. |
| Sequência de execução nos controles de atribuição | Uma conexão com `fresh` e uma execução de cada comando do lote, seguidas de `ROLLBACK` após a rejeição. |

- `node --import tsx --test tests/module-banco-r3.test.ts` passou com
  7 testes e zero pulos, com `AC_BANCO_NATIVE=1` e `AC_BANCO_SQUAWK`
  apontando para o binário local. A execução usou PostgreSQL 17.12
  efêmero por socket Unix, Node 24.22.1, Squawk 2.73.0, Dexter 0.6.3
  e HypoPG 1.4.1.
- `npx tsc --noEmit --skipLibCheck` passou com um link temporário para
  o `dist` já compilado do Cezar. O link foi removido.
- `ruby -c deploy/modules/banco/collector.rb` e `git diff --check` passaram.

## Pendências

Ficam pendentes a validação da versão empacotada pela CLI e a verificação
da persistência de cobertura e achados na integração.
