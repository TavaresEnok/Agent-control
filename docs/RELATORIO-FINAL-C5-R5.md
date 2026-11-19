# C5 R5 — Rejeição diferida e origem das medições SQL

O coletor registra como rejeição SQL a referência a uma restrição inexistente
em `SET CONSTRAINTS` (`42704`) e os erros de cardinalidade de
`SELECT INTO STRICT` (`P0002` e `P0003`). O comando de nível superior recebe
arquivo e linha quando localizável. Se a checagem antecipada disparar um
gatilho de outra migração, o achado pode ter origem no lote. Cancelamento
`57014` e indisponibilidade de conexão continuam com cobertura `failed`.
Uma rejeição SQL confirmada tem cobertura `ok`, com as migrações
sem confirmação sinalizadas no detalhe.

Uma violação de integridade nomeada no cenário do zero ou no prefixo
histórico pode ser repetida em bancos descartáveis criados a partir do mesmo
template. São até dez execuções de prefixos, com orçamento de oito segundos
para as transações de repetição. A atribuição exige reproduzir a violação do
lote original e observar dois prefixos adjacentes, um confirmado e outro
com a mesma violação. A comparação usa os diagnósticos do PostgreSQL,
incluindo a restrição e o detalhe. A saída registra o SQLSTATE e a prova por
prefixos. A linha exata da causa continua indisponível quando o servidor
detecta a violação somente no commit.

Quando apenas o lote fica comprovado, `BANCO-LOTE-MIGRACAO-REJEITADO`
registra a fase da detecção, o número de arquivos e os limites lexicográficos
do grupo. O último arquivo alcançado pela execução e sua primeira linha SQL
servem de referência. A evidência indica que a origem entre os arquivos
ficou indeterminada. O contrato comum continua recebendo arquivo, linha e
evidência no achado, além de `files` nas linhas de cobertura individual bem
sucedidas. O detalhe dessas linhas agora inclui a primeira linha SQL da
consulta, inclusive após comentários multilinha.

## Provas locais

| Cenário sintético | Resultado |
| --- | --- |
| Chave estrangeira diferida em lote de três arquivos | O commit do cenário `fresh` foi rejeitado com `23503`. O prefixo de esquema confirmou e a inclusão de `002_data.sql` reproduziu a mesma violação. A referência do achado foi `002_data.sql:2`. |
| Violação diferente em prefixo com o mesmo SQLSTATE | A comparação rejeitou a atribuição individual e o achado referenciou o grupo de três arquivos. |
| `SET CONSTRAINTS` | A checagem imediata reproduziu a violação diferida de um arquivo anterior. As referências inexistentes de nível superior e em bloco anônimo receberam achados no arquivo em execução. A referência inexistente acionada por gatilho recebeu achado de lote. |
| Cancelamento e indisponibilidade | `57014` durante a execução e no commit gerou cobertura `failed`. A tentativa de conectar a um banco inexistente também gerou `failed`. Os três casos ficaram sem achado de rejeição. |
| Consultas | `pg_stat_statements` e `EXPLAIN` registraram arquivo e linha. A consulta com comentários UTF-8 e multilinha foi localizada na linha 4. |
| Dexter e HypoPG | `banco/queries/by-code.sql:2` teve cobertura `ok` e `BANCO-INDICE-CANDIDATO` para `public.items / item_code`. O custo estimado caiu de 1880,00 para 8,06. O controle com índice real usou `Index Scan`, com custo de 8,31 e zero achados. |
| Squawk | As duas migrações do controle limpo tiveram cobertura `ok` e zero alertas após declarar os timeouts no SQL sintético. A fixture defeituosa continuou sinalizando a remoção da coluna na linha 2. |

- `npx tsc --noEmit --skipLibCheck` passou com um link temporário no worktree
  para o `dist` já compilado do Cezar. O link foi removido após a checagem.
- `ruby -c deploy/modules/banco/collector.rb` e `git diff --check` passaram.
- `node --import tsx --test tests/module-banco-r3.test.ts tests/module-banco.test.ts`
  passou em nove testes focados com `AC_BANCO_NATIVE=1` e `AC_BANCO_SQUAWK`
  apontando para o executável 2.73.0. Foram usados PostgreSQL 17.12, Dexter
  0.6.3 e HypoPG 1.4.1 em diretório temporário, bancos por socket Unix sem
  escuta TCP e papel de projeto restrito. O teste legado vinculado à imagem
  e o laboratório por digest ficaram desabilitados.

## Pendências de integração

A validação pela CLI integrada e da persistência de cobertura e achados
fica para a integração. O digest existente ainda identifica a imagem R4.
