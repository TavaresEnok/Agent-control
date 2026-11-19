# Relatório Final — Módulo 3 (`arquitetura`) — Rodada 3

## 1. Causa identificada

Na rodada anterior (`7709d8bb`), a asserção final de `tests/module-arquitetura-lab.test.ts` (linha 221) exigia cobertura por arquivo (`jscpd:file`) para `src/index.ts` em `untrustedRepo` (cópia do controle limpo com configs maliciosas). Entretanto:

- O `jscpd` 5.4.3 é configurado com `minLines: 8` e `minTokens: 40`, de modo que na fixture `clean` ele mede apenas `src/domain/order.ts` (10 linhas), `src/infra/memory-store.ts` (10 linhas) e `src/services/order-service.ts` (12 linhas), deixando fora `src/index.ts` (7 linhas), `src/routes/orders.ts` (5 linhas) e `src/shared/format.ts` (4 linhas).
- Além disso, ao inspecionar `deploy/modules/arquitetura/collect.mjs`, identificou-se que:
  1. `runCollector` passava todos os `nonTestJsTsFiles` para `parseKnipReport`, emitindo linhas `knip:file` (`problemas=0`) e somando no total de `knip` arquivos explicitamente excluídos por `knipConfig.ignore` (`*.config.{js,ts,mjs,cjs}`, `.dependency-cruiser.{js,cjs,mjs}`, `knip.{js,ts,mjs,cjs}` como `vite.config.ts`, `knip.ts` e `.dependency-cruiser.js`).
  2. `parseDepcruiseReport` emitia entradas `dependency-cruiser:file` e contabilizava em `totalModules` módulos marcados como `coreModule` (ex.: `node:fs`), `couldNotResolve` ou `matchesDoNotFollow`, que não são arquivos do repositório medidos pela análise.

## 2. Alterações realizadas

- **`deploy/modules/arquitetura/collect.mjs`:**
  - Adicionado `isIgnoredByKnipConfig(relFile)` alinhado às exclusões de `buildKnipConfig` (`node_modules/`, `dist/`, `build/`, `coverage/`, `.next/`, `tests/`, `test/`, `__tests__/`, `*.test.*`, `*.spec.*`, `*.d.ts`, `*.config.{js,ts,mjs,cjs}`, `.dependency-cruiser.{js,cjs,mjs}`, `knip.{js,ts,mjs,cjs}`). Em `runCollector`, `knipAnalyzedFiles` filtra `nonTestJsTsFiles` por `!isIgnoredByKnipConfig(f)`, declarando `skipped` quando não há arquivos elegíveis e evitando atribuir métricas de `knip:file` a configs ignoradas.
  - Em `parseDepcruiseReport`, `perFileCoverage` e `totalModules` passam a considerar apenas módulos do repositório (`!mod.coreModule && !mod.couldNotResolve && !mod.matchesDoNotFollow`), sem atribuir métricas por arquivo a módulos nativos (`node:fs`) ou especulativos não resolvidos.
  - Mantido o comportamento de `jscpd:file` e `ast-complexity:file`: `jscpd:file` reporta exclusivamente os arquivos presentes em `summary.files` do `jscpd --complexity`, sem inventar métricas para arquivos não medidos.
- **`tests/module-arquitetura-lab.test.ts`:**
  - Adicionada `assertCleanPerFileCoverage` (usando extração exata `arquivo=...;` em `coverage`) aplicada tanto em `cleanFixture` quanto em `untrustedRepo`:
    - Exige que as quatro ferramentas (`knip:file`, `ast-complexity:file`, `jscpd:file`, `dependency-cruiser:file`) cubram os três arquivos efetivamente medidos por todas (`src/domain/order.ts`, `src/infra/memory-store.ts`, `src/services/order-service.ts`).
    - Verifica expectativa específica por ferramenta: `knip:file` cobre exatamente os 6 arquivos de `src/` (incluindo `src/index.ts`, sem incluir `vite.config.ts`, `knip.ts` ou `.dependency-cruiser.js`); `jscpd:file` cobre exatamente os 3 arquivos medidos e não atribui métricas a `src/index.ts`, `src/routes/orders.ts` nem `src/shared/format.ts`; `ast-complexity:file` e `dependency-cruiser:file` cobrem os 6 arquivos de `src/` (e `dependency-cruiser:file` não lista `node:fs`).
  - Preservadas todas as verificações de defeitos plantados, recusa de rede, raiz ilegível, projeto sem JS/TS (`skipped`) e configs não executadas (canário em `/var/tmp` e `UNTRUSTED_*_EXECUTED`).
- **`tests/module-arquitetura.test.ts`:**
  - Adicionado teste unitário (`cobertura por arquivo reflete apenas os arquivos efetivamente medidos sem atribuir métricas aos ignorados ou não medidos`) validando `runCollector` sobre cópia da fixture `clean` com `vite.config.ts`, `knip.ts` e `.dependency-cruiser.js` (via `spawnSync` simulado com saídas JSON de `knip`, `jscpd` e `depcruise`).

`deploy/modules/arquitetura/digest.txt` não foi criado nem alterado (deixado para o gerente).

## 3. Verificações executadas neste worktree

Comandos executados após a última edição nos arquivos de código e testes:

- `npx tsc --noEmit --skipLibCheck` — passou (`exit 0`).
- `npx tsc --ignoreConfig --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --types node --allowImportingTsExtensions tests/module-arquitetura.test.ts tests/module-arquitetura-lab.test.ts && node --check deploy/modules/arquitetura/collect.mjs` — passou (`exit 0`).
- `node --import tsx --test tests/module-arquitetura.test.ts tests/module-arquitetura-lab.test.ts` — 10 testes listados: **8 passaram, 0 falharam, 2 pulados** (`laboratório módulo 3 encontra os defeitos plantados e não acusa o controle limpo` pulado por ausência de `AC_MODULE_LAB=1`; `hadolint aceita o Dockerfile do módulo quando disponível no PATH` pulado por ausência de `hadolint` no `PATH`).

## 4. Limitações

- Conforme a ordem, a suíte completa, a reconstrução da imagem Docker e o laboratório (`AC_MODULE_LAB=1`) não foram executados neste worktree.
