# C7-SQL — medição local PostgreSQL

## Entrega e integração

`deploy/modules/desempenho/postgres-metrics.mjs` exporta:

```js
async function runPostgresMetrics({workRoot, sqlInfo, pgBinDir, thresholds, version})
// => {summary, extraCoverage, findings, analyzedQueries}
```

O gerente pode integrar ao `collector.mjs` existente, substituindo sua implementação local de `runPgStatStatements` e preservando o restante do fluxo:

```js
import {runPostgresMetrics} from './postgres-metrics.mjs';

const pgResult = await runPostgresMetrics({
  workRoot: WORK_ROOT,
  sqlInfo,
  pgBinDir,
  thresholds,
  version: versions.pg,
});
// Usar pgResult.summary, .extraCoverage, .findings e .analyzedQueries
// nas mesmas posições do resultado anterior.
```

O Dockerfile deverá copiar `postgres-metrics.mjs` para `/opt/desempenho-tools/` junto de `lib.mjs` e do coletor e aplicar-lhe as permissões de leitura/execução adequadas. A dependência `pg` já consta no package-lock do módulo; o servidor PostgreSQL 16 e `pg_stat_statements` precisam estar disponíveis na imagem. Não alterei o Dockerfile nem o coletor.

## Contrato e limites

O código cria um cluster temporário, sem TCP, com socket privado e extensão instalada pelo papel administrativo. Migrações são aplicadas pelo papel restrito em uma transação; consultas SELECT/WITH são executadas pelo mesmo papel em transações somente leitura revertidas, uma instrução por vez no protocolo estendido, sem interpretar comandos psql. A lista de migrações aceita apenas CREATE TABLE/INDEX, INSERT, ALTER TABLE, UPDATE, DELETE e ANALYZE; instruções incompatíveis não são executadas. Estas restrições não pretendem ser um parser SQL completo: o PostgreSQL valida a instrução, o protocolo impede múltiplas instruções por execução e as permissões do papel restringem operações administrativas e arquivos externos. O servidor deve rodar com os limites de CPU, memória, processos e armazenamento do contêiner já estabelecidos pelo orquestrador; `temp_file_limit` não limita tabelas permanentes.

Há limites de 80 arquivos, 256 KiB por arquivo, 100 instruções, 4 segundos por instrução, 1 segundo de lock e 120 segundos de carga, além do timeout do cliente e dos comandos do servidor. O diretório temporário é removido depois da parada; se a parada falhar, o diretório é preservado e a falha é informada em coverage para recuperação. Erros de inventário, inicialização, SQL ou medição são coverage, não achados de lentidão. Consultas não suportadas constam como skipped. A preparação das migrações é confirmada somente no banco descartável; cada medição é revertida.

Para cada instrução, `EXPLAIN` fornece o query ID exato como texto decimal de 64 bits. O coletor zera seletivamente os contadores daquele papel, banco e query ID, toma a leitura anterior, executa três amostras e toma a leitura posterior. Exige exatamente três chamadas e zero chamadas anteriores; o máximo é válido porque o reset é específico do caso. Mesmo instruções de arquivos ou linhas diferentes com query ID igual, inclusive as que diferem só em literais, são medidas independentemente. Coverage e achados vinculam arquivo, linha, hash da instrução, query ID, contagens e tempos anterior/posterior. O controle rápido usa a mesma estrutura e não gera finding. Snapshots externos são marcados como ignorados e não alimentam a medição.

## Evidência executada

- `node --test tests/postgres-metrics.test.mjs`: 4 testes aprovados, 1 prova de servidor real pulada por falta dos binários PostgreSQL 16 locais. O fluxo simulado verifica duas instruções de mesmo query ID com tempos distintos, precisão do ID de 64 bits, reset por caso, rollback, papel restrito, protocolo estendido, controle limpo, snapshot externo e recusa de DDL em consulta. Também cobre separação SQL, limites de contadores e falha do coletor sem finding.
- `npx tsc --noEmit --skipLibCheck`: aprovado.
- PostgreSQL 16 (`initdb`, `pg_ctl` e `postgres`) não estava disponível nos caminhos locais; portanto não foi executada a prova com servidor efêmero real. O teste condicional permanece pronto para um ambiente que tenha esses binários. Nenhuma imagem foi construída e nenhuma instalação viva foi acessada.

A prova simulada não substitui a prova real: a integração deve ser validada com PostgreSQL 16 e `pg_stat_statements` antes de tratar o estágio como comprovado em produção.
