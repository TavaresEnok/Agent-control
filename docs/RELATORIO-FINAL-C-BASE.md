# Relatório Final — Parte C (Base): Execução Pessoal e Relatórios dos Módulos 2 a 9

## 1. Escopo implementado

Implementação do caminho comum de execução, isolamento de contexto, persistência no ledger, relatórios privados rastreáveis e conversão idempotente de achados em tarefas do produto para os oito módulos de verificação (`qa`, `arquitetura`, `dependencias`, `banco`, `prontidao`, `desempenho`, `documentacao`, `conformidade`):

- **`db/migrations/104_verification_modules.sql`**:
  - Estende a restrição `ac_exam_contexts_module_check` de `ac_exam_contexts` para admitir `design`, `verify`, `qa`, `arquitetura`, `dependencias`, `banco`, `prontidao`, `desempenho`, `documentacao` e `conformidade`.
  - Adiciona a coluna `module` em `ac_verify_runs` (`DEFAULT 'verify'`, restrita aos módulos válidos).
  - Adiciona o trigger `ac_verify_runs_context_guard` (`ac_check_verify_run_context()`), garantindo no banco que `context_id` pertence a `project_id`, `intent_id` pertence a `context_id`, e todo run dos módulos 2 a 9 está estritamente vinculado ao seu contexto dedicado em `ac_exam_contexts(project_id, module, context_id)`.
  - Cria a tabela `ac_verify_tool_coverage (run_id, seq, tool, version, status, detail)` com `PRIMARY KEY (run_id, seq)` e `status IN ('ok', 'failed', 'skipped')`, preservando na ordem todas as linhas de cobertura de ferramentas, incluindo linhas adicionais por arquivo, rota ou requisito.
- **`src/ledger.ts`**:
  - Exporta `VERIFICATION_MODULES` e `VerificationModule`, estendendo `ExamModule` e `Ledger.ensureExamContext(principal, projectId, module)` para criar e reutilizar o contexto de exame dedicado por `(projectId, module)` sem tocar na locação do gerente do contexto principal.
- **`src/verification-modules.ts`**:
  - Construção dos argumentos de execução isolada do contêiner coletor (`moduleCollectorArguments`): inicia pelo `ENTRYPOINT` padrão da imagem fixada por digest (`deploy/modules/<modulo>/digest.txt`), monta o snapshot `git archive` do commit em `/repo` somente leitura (`dst=/repo,readonly`), raiz `--read-only`, usuário sem privilégio `65532:65532`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `/tmp` gravável em tmpfs, sem socket, sem login real e `--network none`.
  - Validação rigorosa do stdout JSON UTF-8 do coletor (`parseModuleCollectorOutput`, `runBoundedCollectorProcess`): valida limite de bytes de stdout (`MAX_COLLECTOR_STDOUT_BYTES = 8 MiB`), formato `{coverage:[{tool,version,status,detail}],findings:[{tool,rule,file,line,severity,message,evidence}]}`, `status` em `ok | failed | skipped`, `severity` em `alta | media | baixa | informativa`, `line` inteiro `>= 1`, caminhos relativos seguros dentro do repositório (recusando `..`, caminhos absolutos, symlinks, `.git`, `.github`, `.ai`, `node_modules`, `.env*`, `.claude`, `.codex`, `.grok`, `.mcp.json`, `.husky`) e redação de segredos antes de persistir.
  - Gravação e leitura de relatórios privados em `<dataDirectory>/verificacoes/<projectId>/<YYYYMMDD-HHMMSS>-<sufixo>-<modulo>/` com permissões `0700` nos diretórios e `0600` nos arquivos (`README.md`, `mapa.md`, `cobertura.md`, `achados.json`, `achados/ACH-001.md`…, `bruto/achados-brutos.json`, `run.json`).
  - Tratamento de falha de ferramenta: ferramentas com `status: 'failed'` ficam registradas na cobertura (`cobertura.md`, `README.md`, `run.json` e `ac_verify_tool_coverage`), o relatório completo é gravado e persistido, e a CLI sai com código de erro (`VERIFY_TOOLS_FAILED`, status 1) após gravar o relatório.
  - Isolamento nos pedidos de revisão (`buildModuleReviewPrompt`, `recheckModuleFindings`): envia apenas módulo, ferramenta, regra, arquivo, linha, evidência bruta e trecho de código, excluindo qualquer conclusão do autor ou examinador (`message`, `scenario`, `suggestion`, `conclusion`).
  - Conversão idempotente de achados em tarefas do produto (`requestModuleCorrection`): converte achados `confirmado` ou `reaberto` em mensagem do titular (`ac_personal_messages`) e registro em `ac_verify_remediations` sob bloqueio transacional (`FOR UPDATE`), vinculando ao projeto, caminhos reais de escrita no repositório (`writePaths`), teste de regressão (`tests/<modulo>/ach-xxx.test.ts`) e critério de aceite (`REMEDIATION_ACCEPTANCE`).
- **`src/personal-module-cli.ts`, `src/personal-qa-cli.ts`, `scripts/personal-<modulo>.mjs` e `package.json`**:
  - Implementa as oito CLIs `npm run personal:<modulo> -- <instalação.json> <projeto> [--corrigir <runId> <ACH-001...> | --descartar <runId>]`.
  - Mantém compatibilidade integral com `npm run personal:qa -- <instalação.json> <projeto> show|set|clear`.

## 2. Passos de build (para o gerente no host)

Para cada módulo `<modulo>` em `qa`, `arquitetura`, `dependencias`, `banco`, `prontidao`, `desempenho`, `documentacao`, `conformidade`:

```bash
docker build -t ac-module-<modulo>:local deploy/modules/<modulo>
docker image inspect ac-module-<modulo>:local --format '{{.Id}}' > deploy/modules/<modulo>/digest.txt
```

## 3. Passos de laboratório (para o gerente no host)

Com o arquivo `deploy/modules/<modulo>/digest.txt` preenchido com o ID imutável (`sha256:<64hex>`):

```bash
AC_MODULE_LAB=1 node --import tsx --test tests/module-<modulo>*.test.ts
```

Para executar uma CLI diretamente numa instalação pessoal declarada:

```bash
npm run personal:<modulo> -- /caminho/para/installation.json <projeto>
npm run personal:<modulo> -- /caminho/para/installation.json <projeto> --corrigir <runId> ACH-001
npm run personal:<modulo> -- /caminho/para/installation.json <projeto> --descartar <runId>
```

## 4. Prova executada neste worktree

1. **Verificação estática de tipos (`tsc`)**:
   ```bash
   npx tsc --noEmit --skipLibCheck
   ```
   Resultado: código de saída `0`, sem erros.
2. **Testes isolados dos arquivos alterados (com banco descartável isolado via `isolatedDatabase`)**:
   ```bash
   umask 022 && AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test env -u NO_COLOR -u FORCE_COLOR node --import tsx --test tests/verification-modules.test.ts tests/personal-qa-cli.test.ts
   ```
   Resultado: 8 testes executados, 8 aprovados, 0 falhas.

## 5. Limitações

- Conforme a ordem, os coletores específicos em `deploy/modules/<modulo>/` pertencem aos trabalhadores C2 a C9 e os arquivos `deploy/modules/<modulo>/digest.txt` serão gerados pelo gerente no momento do build das imagens no host.
- Nenhuma imagem Docker foi reconstruída, nenhum laboratório com `AC_MODULE_LAB=1` foi acionado e a instalação viva não foi tocada.
