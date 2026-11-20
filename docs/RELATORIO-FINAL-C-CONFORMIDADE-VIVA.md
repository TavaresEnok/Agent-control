# Preservação dos resultados medidos em conformidade parcial

## Causa identificada

Na coleta de conformidade (`deploy/modules/conformidade`), cada ferramenta emitia achados sob seu identificador principal (`lgpd-static`, `scancode-toolkit`, `npm-license-policy`, `ort`, `presidio-analyzer`) e uma única linha agregada de cobertura com esse mesmo `tool`, enquanto o detalhe por arquivo usava sufixo `:file` sem o campo `files`. Quando qualquer arquivo apresentava cobertura parcial ou falha (por exemplo, uma chamada SQL sem comando literal em `lgpd-static`), a linha agregada recebia `status: "failed"`, deixando os achados válidos da ferramenta sem nenhuma linha `status: "ok"` correspondente na publicação (`VERIFY_COLLECTOR_INVALID`).

## Correções realizadas

- `deploy/modules/conformidade/collector.py`:
  - `Report.cover` passa a aceitar `files` opcional (ordenado e sem duplicatas) e aplica `MAX_FILE_COVERAGE` (`MAX_COVERAGE - 49`) às linhas `:file` para evitar que o teto de cobertura descarte os resumos e escopos `ok` das ferramentas, preservando `MAX_COVERAGE = 4999` e `MAX_FINDINGS = 999`.
  - `inspect_privacy` mantém a linha agregada `lgpd-static` como `failed` (ou `skipped`) e as linhas `lgpd-static:file` individuais com as lacunas reais (`Cobertura parcial: ...`), emitindo linhas `lgpd-static` com `status: "ok"` e `files` estritamente vinculadas aos arquivos AST sem lacunas e aos arquivos com evidências locais efetivamente produzidas (vínculos AST confirmados ou inventário textual de campos). Arquivos não medidos, com erro de sintaxe sem achado, SQL não analisável sem achado ou texto fora de código/config permanecem fora de `files`.
  - O mesmo contrato `files` e preservação de falhas parciais foi aplicado a `scancode-toolkit` (`add_scancode_results` e `scan_licenses`), `npm-license-policy` (`inspect_npm`) e `presidio-analyzer` (`inspect_privacy`). `add_scancode_results` também valida os caminhos antes de emitir achados.
- `deploy/modules/conformidade/ort_inventory.py`:
  - `read_results` valida as coordenadas antes de emitir achados e registra os lockfiles efetivamente medidos, mantendo `ort:file` inalterado; `scan` vincula `files` à linha `ort` `status: "ok"` e preserva a linha `failed` quando há falha parcial ou código de saída diferente de zero.
- `tests/fixtures/module-conformidade/escopo-parcial/` e `tests/module-conformidade.test.ts`:
  - Adicionada fixture sintética `escopo-parcial` (`src/sustained-partial.ts` com achado `PII_POSSIBLE_NETWORK` sustentado na linha 15 e `db.query(command, [payload])` não medido, `src/clean-ast.ts`, `src/unmeasured-sql.ts`, `docs/notes.txt`) além de arquivo sintético com erro de sintaxe e `.env.synthetic` no teste.
  - Adicionados 3 testes cobrindo publicação via `parseModuleCollectorOutput` e `writeModuleReport`, vínculo pelo contrato `files` em `lgpd-static`, `scancode-toolkit`, `npm-license-policy`, `ort` e `presidio-analyzer`, recusa de achado fora de `files`, falha total sem `ok` inventado e preservação dos limites (`MAX_FINDINGS = 999` e `MAX_COVERAGE`).

## Provas executadas

- `npx tsc --noEmit --skipLibCheck`: aprovado (código 0).
- `node --import tsx --test tests/module-conformidade.test.ts`: 33 testes aprovados, 0 falhas, 0 ignorados (executado após a última edição em dados e mocks sintéticos; ferramentas externas `scancode`, `ort` e modelo Presidio substituídos por mocks locais nos testes de integração do coletor).
- `git diff --check`: sem erros de formatação ou espaço em branco.
- Escopo respeitado: apenas `deploy/modules/conformidade`, `tests/module-conformidade.test.ts`, `tests/fixtures/module-conformidade/escopo-parcial` e este relatório foram alterados, sem tocar instalação viva, imagens, produção ou predicado do host.
