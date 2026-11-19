# C5 R4 — Rejeição de migrações e cobertura de consultas

## Migrações

O coletor executa os arquivos em ordem lexicográfica, inclusive quando os
prefixos numéricos têm larguras diferentes. Cada sequência usa uma transação e
envia um arquivo por vez. Isso acompanha a ordenação e a aplicação das migrações
pendentes em `Ledger.migrate()` e `Ledger.tx()`, em `src/ledger.ts`. Na prova
histórica, o prefixo e a última migração são transações distintas. O coletor
recusa comandos explícitos de controle transacional e tem inventário e
contrato próprios, independentes da tabela de versões e digests do Ledger.

Se `SET CONSTRAINTS … IMMEDIATE` puder ter antecipado uma validação de
alterações de arquivos anteriores, a cobertura registra o arquivo em
execução, o SQLSTATE e a origem indeterminada. Indica a linha do comando quando
o ponto de detecção é identificável. Em arquivos com várias instruções, sem
cursor externo do servidor, só é possível localizar a detecção no arquivo.
O contexto do PostgreSQL também pode identificar `SET CONSTRAINTS` chamado
por PL/pgSQL, sem expor o contexto bruto. Uma rejeição com cursor em outro
comando continua gerando o achado específico.

Uma rejeição comprovada no `COMMIT`, como `23503`, recebe uma linha de
cobertura `ok` com o resultado do lote. Os arquivos da transação ficam
`skipped`, com a indicação de que sua aplicação ficou sem confirmação. Quando
o lote tem um só arquivo, o coletor também gera o achado desse arquivo e
indica que a linha exata ficou indisponível. Para vários arquivos, a rejeição
consta na cobertura, com origem indeterminada. Um cancelamento `57014` recebe
`failed` para o lote e os arquivos ficam `skipped`. Ambos os casos impedem
prosseguir com as medições que dependiam daquela transação.

`P0001`, o SQLSTATE padrão de `RAISE EXCEPTION` em PL/pgSQL, gera achado de
rejeição na migração ou no invariante histórico. Os cursores do PostgreSQL e do
`PgQuery::ParseError` da versão instalada contam caracteres UTF-8 a partir de
1. Os offsets da árvore e do scanner continuam sendo tratados em bytes. O
relatório usa SQLSTATE do servidor ou a classe do erro do parser, sem incluir
mensagens do banco, texto SQL ou valores das linhas.

## Consultas e carga sintética

Em ordem lexicográfica, até 40 arquivos regulares com nome elegível, UTF-8
válido, até 256 KiB e um único SELECT passam à medição. O inventário registra
entradas inválidas sem consumir essas vagas. Quando as 40 vagas estão
preenchidas, as demais entradas com nome elegível são registradas como
excedentes sem abrir seu conteúdo. O relatório detalha até 40 entradas
inválidas ou excedentes e informa a contagem das demais por motivo. Erros que
só aparecem no PostgreSQL, como uma tabela ausente, ficam na cobertura da
consulta selecionada. As medições bem-sucedidas informam os caminhos no
campo `files` para persistência da cobertura individual.

`banco/workload.sql` tem precedência sobre `banco/seed.sql` e só aciona o
fallback quando o arquivo de carga está ausente. Se a carga está vazia,
ilegível ou falha ao analisar ou executar, a cobertura indica a falha e as
consultas são medidas com os dados que restaram após as migrações. O seed
continua sendo aplicado normalmente no cenário histórico.

## Provas e integração pendente

- Nove testes focados rodaram com PostgreSQL 17.12, Dexter, HypoPG e Squawk.
  Montaram o coletor do worktree somente para leitura sobre a imagem já
  disponível, com rede desligada, socket Unix local, dados sintéticos, papel
  `projeto` restrito e limites de tempo e recursos. As provas incluem
  rejeição imediata, antecipada e diferida, rollback, cancelamento durante
  instrução e no commit, `P0001`, linha em UTF-8, falhas de carga, 40 consultas
  medidas com extras e restauração com controle limpo.
- `npx tsc --noEmit --skipLibCheck` passou com um link temporário no worktree
  para o `dist` do Cezar já compilado no checkout principal. A primeira
  execução encontrou a dependência compilada ausente. O link foi removido ao
  fim da checagem. `ruby -c deploy/modules/banco/collector.rb` e
  `git diff --check` também passaram.

O gerente pode usar cada subdiretório de `tests/fixtures/module-banco/r4-commit/`
como raiz de um repositório Git sintético, com as duas migrações commitadas, e
rodar `npm run personal:banco -- <instalação-descartável.json> <projeto>` após
integrar o módulo e fixar a imagem reconstruída. A saída do coletor para essas
fixtures já foi exercitada no PostgreSQL real. Na CLI integrada, as
expectativas são as seguintes.

| Fixture | Saída esperada da CLI | Resultado esperado em `cobertura.md` e `ac_verify_tool_coverage` |
| --- | --- | --- |
| `rejected` | Código 0, identificador e caminho do relatório | `pg-migrate:fresh` com `ok`, lote rejeitado no commit, `23503` e origem indeterminada. A atualização de um só arquivo também tem achado em `002_data.sql`. |
| `canceled` | Código 1, identificador e caminho do relatório e mensagem de falha da ferramenta | `pg-migrate:fresh` com `failed`, medição interrompida no commit e `57014`. O gatilho diferido solicita o cancelamento da própria sessão efêmera. |

A prova da saída persistida da CLI, a reconstrução e a fixação da imagem
ficam com o gerente. O digest do ramo segue o de `fbd1ed3f`.
