# Conformidade — vínculo de arquivos na publicação e truncamento

Base `1d538165` no worktree `final-c9-escopo` (já contendo o contrato compartilhado do consumidor introduzido em `3890f594`).

## Correções no coletor

- [collector.py](file:///home/app/projects/ac-wt/final-c9-escopo/deploy/modules/conformidade/collector.py):
  - `Report.cover` agora aceita `require_findings=False` e marca `self.has_errors = True` imediatamente quando uma linha de cobertura excede `MAX_FILE_COVERAGE` ou `MAX_COVERAGE`.
  - `Report.find` marca `self.has_errors = True` assim que `self.finding_count > MAX_FINDINGS`.
  - `Report.output` resolve os achados finais (`[:MAX_FINDINGS]`) antes de fechar a cobertura: para linhas registradas com `require_findings=True`, mantém em `files` apenas os arquivos que possuem pelo menos um achado publicado para o respectivo `tool` e atualiza a contagem no `detail`. Quando nenhum arquivo parcial possui achado publicado após o corte, a linha `ok` de evidência parcial é omitida. Arquivos analisados até o fim (`static_ok_files`, `presidio_ok_files` e equivalentes completos) permanecem em `files` mesmo com zero achados.
  - Em `inspect_privacy`, as linhas `ok` de escopo parcial (`static_partial_finding_files` para `lgpd-static` e `presidio_partial_finding_files` para `presidio-analyzer`) usam `require_findings=True`.
- [ort_inventory.py](file:///home/app/projects/ac-wt/final-c9-escopo/deploy/modules/conformidade/ort_inventory.py):
  - `read_results` e `scan` separam lockfiles completamente classificados (`classified[file] == count`, preservados mesmo sem achados) dos lockfiles parciais sustentados apenas por achado (`partial_finding_files`), emitindo estes últimos com `require_findings=True`.

## Correções nos testes e provas executadas

- [module-conformidade.test.ts](file:///home/app/projects/ac-wt/final-c9-escopo/tests/module-conformidade.test.ts):
  - Removido o helper local `assertFindingsCoveredByFiles`; os testes agora chamam diretamente a função de produção `validateModuleCollectorPublication` exportada por [verification-modules.ts](file:///home/app/projects/ac-wt/final-c9-escopo/src/verification-modules.ts) contra diretórios sintéticos reais em disco.
  - Com ambos os arquivos presentes no snapshot (`src/clean-ast.ts` e `src/unmeasured-sql.ts`), `validateModuleCollectorPublication` aceita o achado dentro do escopo declarado (`src/clean-ast.ts`) e rejeita com `Refusal` (`VERIFY_COLLECTOR_INVALID`, status `400`) o achado fora da cobertura declarada (`src/unmeasured-sql.ts`), além de rejeitar lista `files: []` ou declaração restrita à linha `failed`. O fluxo completo de publicação de arquivos do relatório segue verificado via `writeModuleReport` (o caminho completo com PostgreSQL via `runVerificationModule` não foi executado por ausência de `AC_TEST_DATABASE_URL` neste ambiente).
  - Os testes de truncamento passaram a provar os limites separadamente e em conjunto:
    - Cobertura truncada isolada com zero achados (`conformidade:output` `status: "failed"`, `report.has_errors === True`, `detail` com contagem exata de linhas de cobertura omitidas e `0 achados omitidos`, preservando arquivo AST completo sem achados em `files`).
    - Limite de achados isolado (`0 linhas de cobertura` e contagem exata de `achados omitidos`, excluindo de `files` arquivos parciais de `lgpd-static`, `presidio-analyzer` e `ort` cujos achados foram descartados pelo teto — inclusive por deslocamento de severidade — e omitindo a linha `ok` parcial quando nenhum achado parcial sobrevive, mantendo arquivos completos com zero achados).
    - Ambos os limites excedidos simultaneamente, verificando ambas as contagens explícitas na mensagem de `conformidade:output`.

## Comandos executados após a última edição

- `npx tsc --noEmit --skipLibCheck`: aprovado (código `0`).
- `node --import tsx --test tests/module-conformidade.test.ts`: 35 testes aprovados, 0 falhas, 0 ignorados (dados e mocks sintéticos locais).
- `git diff --check`: sem erros de formatação ou espaços em branco.
