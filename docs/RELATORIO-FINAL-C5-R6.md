# C5 R6 — Origem das rejeições de migração

O coletor usa o diagnóstico da execução original para atribuir violações
diferidas de chave estrangeira. A atribuição exige que o PostgreSQL
identifique a tabela e a restrição e que a árvore SQL do lote demonstre
um único arquivo com inserções nessa tabela. A regra cobre tabelas
comuns criadas em `public` no próprio lote, colunas e restrições simples,
inserções literais e comandos sem escrita nas tabelas.

Quando o SQL sai desse subconjunto ou há mais de um arquivo escritor, o
achado registra a rejeição do lote e o ponto de detecção. O campo de
arquivo e a linha servem de referência ao último arquivo alcançado.
A busca por prefixos, o banco auxiliar e os limites locais de repetição
foram removidos.

## Provas focadas

| Caso sintético | Evidência |
| --- | --- |
| Chave estrangeira simples | `002_data.sql` foi atribuído tanto na rejeição no `COMMIT` quanto na checagem antecipada por `SET CONSTRAINTS`. O SQLSTATE e a estrutura do lote fundamentam o achado. |
| Inserção, remoção e reinserção da mesma linha | `23503` no `COMMIT`, com origem indeterminada. O teste verifica uma conexão com `fresh` e uma execução de cada comando do lote. |
| Remoção da linha referenciada | `23503` detectado no `SET CONSTRAINTS IMMEDIATE`, com origem indeterminada. |
| DML condicionado a `current_database()` | `23503` no `COMMIT` da execução original, com origem indeterminada. O teste confirma que somente `fresh` foi acessado e que os comandos foram executados uma vez. |
| `SET CONSTRAINTS` multilinha em bloco anônimo | O erro direto de restrição inexistente foi associado ao próprio arquivo. O erro surgido em um gatilho durante uma checagem antecipada conservou a origem indeterminada. |
| Timeout de transação | O PostgreSQL emitiu `25P04` a partir de uma exceção sintética, e o coletor registrou cobertura `failed` e zero achados. Em uma sondagem com timeout real, o libpq retornou `PG::ConnectionBad`, também registrado como falha de medição. |
| Squawk e Dexter | Squawk localizou a remoção de coluna defeituosa na linha 2. O Dexter atribuiu o índice hipotético a `banco/queries/by-code.sql`, linha 2, e o controle limpo ficou sem achados. |

- `node --import tsx --test tests/module-banco-r3.test.ts tests/module-banco.test.ts`
  teve 10 aprovações e 2 testes desabilitados, vinculados à imagem e ao
  laboratório. A execução nativa usou Node 22.23.4, PostgreSQL 17.12 em
  diretório efêmero com socket Unix, Squawk 2.73.0, Dexter 0.6.3 e HypoPG 1.4.1.
- `npx tsc --noEmit --skipLibCheck` passou com um link temporário para
  o `dist` do Cezar já compilado. O link foi removido após a checagem.
- `ruby -c deploy/modules/banco/collector.rb` e `git diff --check` passaram.

## Pendências de integração

Ficam pendentes a validação da versão empacotada pela CLI e a verificação
da persistência da cobertura e dos achados. A rodada usou somente
ferramentas nativas e dados sintéticos.
