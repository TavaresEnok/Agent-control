# Relatório Final — Parte C: Laboratório Ponta a Ponta das CLIs Pessoais (`verification-module-cli-lab`)

## 1. Escopo implementado

Implementação do laboratório reutilizável em `tests/verification-module-cli-lab.test.ts` (sem alterar `tests/verification-modules.test.ts` nem as fixtures `tests/fixtures/module-*` dos outros colaboradores), cobrindo a junção completa entre a entrada normal da CLI (`npm run personal:<modulo>`), o snapshot isolado do Git (`git archive` de `HEAD`), a execução do contêiner fixado por `deploy/modules/<modulo>/digest.txt`, os limites reais de saída (`VERIFY_STDOUT_LIMIT`), a gravação de relatórios privados, o isolamento em contexto dedicado e a conversão idempotente em tarefa do projeto (`--corrigir`).

Principais pontos implementados em `tests/verification-module-cli-lab.test.ts`:

- **Seleção de módulo pelo gerente (`resolveSelectedLabModules`)**:
  - Suporta seleção de um único módulo via `AC_MODULE_LAB_MODULE=<modulo>` ou lista separada por vírgula via `AC_MODULE_LAB_MODULES=<m1,m2,...>` (ou `all`/ausente para executar todos os oito módulos de `VERIFICATION_MODULES`: `qa`, `arquitetura`, `dependencias`, `banco`, `prontidao`, `desempenho`, `documentacao`, `conformidade`).
  - Nomes inválidos falham imediatamente com `Refusal('INVALID_CONTRACT')`.
- **Falha explícita na ausência de digest ou fixture (`resolveModuleLabInputs`)**:
  - Quando `AC_MODULE_LAB=1` está habilitado, verifica antes da execução que `AC_TEST_DATABASE_URL`, `deploy/modules/<modulo>/digest.txt` (via `readPinnedModuleImage`) e o diretório de fixture com defeito existem e são válidos; a ausência de qualquer um deles é falha imediata (nunca pulo silencioso).
- **Banco e instalação pessoal descartáveis + repositório Git sintético**:
  - Cria banco isolado com `isolatedDatabase(databaseUrl, 'vmodclilab')`, executa `db.migrate()`, ativa o modo `personal` em `ac_installation_activation` e registra projeto, dono, repositório, contexto principal e locação de gerente (`live-gateway-manager`) conforme o esquema de `tests/verification-modules.test.ts`.
  - Constrói repositório Git sintético a partir da fixture com defeito do módulo (`git init`, `git add -A`, `git commit`) e adiciona um arquivo não rastreado (`untracked-working-tree-only.ts`) para confirmar que `bruto/achados-brutos.json` não recebe alterações fora de `HEAD`.
  - Grava `installation.json` descartável com permissão `0600` e `dataDirectory` com permissão `0700` fora do repositório.
- **Execução real pela entrada normal da CLI (`npm run personal:<modulo>`)**:
  - Dispara `npm run personal:<modulo> -- <installation.json> <projeto>` em subprocesso real, sem injeção de `collectorOutput` e sem mock de Docker.
  - Valida relatório privado fora do repositório, permissões (`0700` no diretório do run e `0600` em `README.md`, `mapa.md`, `cobertura.md`, `achados.json`, `run.json`, `bruto/achados-brutos.json` e `achados/<ACH>.md`), contexto dedicado distinto do contexto principal, preservação do epoch do gerente principal, cobertura de ferramentas em `ac_verify_tool_coverage` e no Markdown, e presença de um achado `confirmado` esperado.
  - Dispara `npm run personal:<modulo> -- <installation.json> <projeto> --corrigir <runId> <ACH>` duas vezes e confere saída idêntica e criação de uma única tarefa (`ac_verify_remediations` e `ac_personal_messages` no contexto principal) ligada ao projeto, com `write_paths`, `regression_test` e `REMEDIATION_ACCEPTANCE`.
  - Executa `runPersonalModuleCli(module, [installationPath, projectId], {maxStdoutBytes: 64})` contra o contêiner real (no primeiro módulo selecionado) para provar o corte por `VERIFY_STDOUT_LIMIT` e a marcação de `failed` em `ac_verify_runs` e `ac_intents`.

## 2. Mapeamento das fixtures e propriedades lidas nos worktrees

Leitura (somente leitura) dos worktrees `final-c2` a `final-c9`:

| Módulo | Worktree consultado | Fixture com defeito | Ferramentas `ok` e propriedade verificada |
|---|---|---|---|
| `qa` | `final-c2` | `tests/fixtures/module-qa` | `istanbul-coverage`, `stryker-mutator`, `fast-check`, `playwright-test-audit`, `axe-core`, `swagger-parser`; achado em `src/defective-pricing.ts` (`QA-COBERTURA-FUNCAO-SEM-TESTE`, `QA-STRYKER-MUTANTE-SOBREVIVENTE` ou `QA-FASTCHECK-PROPRIEDADE-VIOLADA`) e cobertura `qa-arquivo:src/defective-pricing.ts` |
| `arquitetura` | `final-c3` | `tests/fixtures/module-arquitetura/defective` | `knip`, `ast-complexity`, `jscpd`, `dependency-cruiser`; achado `KNIP-UNUSED-FILE` em `src/legacy-dead.ts` e cobertura `knip:file` |
| `dependencias` | `final-c4` | `tests/fixtures/module-dependencias/com-defeito` | `npm-check-updates`, `ast-grep`, `jscodeshift`, `sbom-lockfile`; achado `ASTGREP-EXPRESS5-APP-DEL` em `src/server.ts` |
| `banco` | `final-c5` (ainda na base `b79016a4`, sem fixture no worktree) | Candidatos: `defective`, `com-defeito`, `defeito` ou raiz `tests/fixtures/module-banco` | Cobertura sem falhas, ao menos uma ferramenta `ok` e um achado `confirmado` válido |
| `prontidao` | `final-c6` / `final-c6-r2` | `tests/fixtures/module-prontidao/defective` | `prontidao-audit`, `gitleaks`, `hadolint`, `trivy`; achado em `src/tls-client.ts` (`PRONTIDAO-TLS-VERIFICACAO-DESABILITADA`), `Dockerfile` ou `compose.yml` e cobertura `prontidao:requisito:` |
| `desempenho` | `final-c7` | `tests/fixtures/module-desempenho/defective` | `lighthouse-ci`, `k6`, `node-cpu-prof`, `pg_stat_statements`; achado em `server.mjs` (`K6-THRESHOLD-LATENCY-P95` ou `CPU-PROF-HOTSPOT`) e cobertura `node-cpu-prof:arquivo:` |
| `documentacao` | `final-c8` | `tests/fixtures/module-documentacao` | `typedoc`, `dependency-cruiser`, `mermaid`; achado `DOC-TYPEDOC-PARAM-DESATUALIZADO` em `src/billing.ts` e cobertura `typedoc:file` |
| `conformidade` | `final-c9` (ainda na base `b79016a4`, sem fixture no worktree) | Candidatos: `defective`, `com-defeito`, `defeito` ou raiz `tests/fixtures/module-conformidade` | Cobertura sem falhas, ao menos uma ferramenta `ok` e um achado `confirmado` válido |

## 3. Como o gerente executa no host

Para validar um módulo específico após integrar o ramo correspondente e gravar `deploy/modules/<modulo>/digest.txt`:

```bash
AC_MODULE_LAB=1 AC_MODULE_LAB_MODULE=<modulo> AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test env -u NO_COLOR -u FORCE_COLOR node --import tsx --test tests/verification-module-cli-lab.test.ts
```

Para rodar a prova final dos oito módulos integrados (ou omitindo `AC_MODULE_LAB_MODULES`):

```bash
AC_MODULE_LAB=1 AC_MODULE_LAB_MODULES=all AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test env -u NO_COLOR -u FORCE_COLOR node --import tsx --test tests/verification-module-cli-lab.test.ts
```

## 4. Prova executada neste worktree

1. **Verificação estática de tipos**:
   ```bash
   npx tsc --noEmit --skipLibCheck
   ```
   Resultado: saída `0`, sem erros.
2. **Testes direcionados do arquivo criado (sem `AC_MODULE_LAB=1`)**:
   ```bash
   env -u NO_COLOR -u FORCE_COLOR node --import tsx --test tests/verification-module-cli-lab.test.ts
   ```
   Resultado: 3 testes listados, 2 aprovados (seleção de módulos e falha explícita por ausência de `digest.txt`/fixture), 1 pulado (`# AC_MODULE_LAB=1 is unset`), 0 falhas.

## 5. Observações e limitações

- Conforme a ordem, não foi executada a suíte completa, não foi executado o laboratório com `AC_MODULE_LAB=1`, nenhuma imagem Docker foi construída e a instalação viva não foi tocada.
- **Observação para a integração de `prontidao` (`final-c6` / `final-c6-r2`)**: na inspeção estática, `tests/fixtures/module-prontidao/defective/` contém o arquivo `.env`, e o coletor de prontidão emite achado com `file: '.env'` (e `gitleaks` também aponta `.env`), enquanto `assertModuleRepoRelativePath` em `src/verification-modules.ts` recusa segmentos iniciados por `.env` com `VERIFY_PATH_FORBIDDEN`. Caso essa combinação permaneça na integração de C6, o laboratório ponta a ponta acusará corretamente essa recusa até que o caminho/fixture seja ajustado no módulo ou na regra.
- Os worktrees `final-c5` (`banco`) e `final-c9` (`conformidade`) ainda estavam em `b79016a4` no momento desta entrega, sem `tests/fixtures/module-*` ou `tests/module-*.test.ts`; os critérios para esses dois módulos na tabela usam os padrões de diretório de fixture esperados e validação estrutural de cobertura e achado confirmado.
