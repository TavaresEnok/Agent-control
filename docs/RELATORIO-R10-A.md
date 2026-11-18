# Relatório — Reconstrução do design, rodada 10 (Bloco A)

Trabalhador A, no worktree `/home/app/projects/agent-control-design-b` (ramo `task/design-r5-b`), executando `docs/ORDEM-DESIGN-RECONSTRUCAO-10.md`.

## Commits

1. **`fadd0961`** — `Isolate design and verify exams in dedicated contexts, assign prepare policy to all contexts, and restore wiped Claude logins`
   - **1 e 4. Contexto dedicado de exame por projeto e por módulo (`db/migrations/102_exam_contexts.sql`, `src/ledger.ts`, `src/design-command.ts`, `src/verify-command.ts`, `src/server-main.ts`, `src/native-setup.ts`):**
     - Criada a migração `102_exam_contexts.sql` com a tabela `ac_exam_contexts(project_id, module, context_id, created_at)` (`PRIMARY KEY (project_id, module)`, `module IN ('design', 'verify')`).
     - Adicionados `ExamModule`, `ExamContext` e `Ledger.ensureExamContext(principal, projectId, module)` em `src/ledger.ts`. A função serializa por `(projectId, module)` via advisory lock transacional, localiza o contexto principal não arquivado do projeto (excluindo `ac_exam_contexts`), cria ou reaproveita o contexto dedicado de exame e retorna `{contextId, mainContextId, policyRevision, capacityPolicyRevision, mainCapacityPolicyRevision}`.
     - `resolvePersonalDesign` (`src/design-command.ts`) e `resolvePersonalVerification` (`src/verify-command.ts`) passaram a obter o contexto dedicado por `ledger.ensureExamContext` em vez de consultar o contexto mais antigo do projeto, mantendo o contexto principal e o `epoch` do gateway intactos. Em falha de setup após o `acquire`, o lease do contexto dedicado é liberado antes de fechar o `Ledger`, e `close()` também libera o lease.
     - `src/server-main.ts` e `src/native-setup.ts` passaram a excluir `ac_exam_contexts` ao selecionar o contexto principal do projeto.
   - **2. Política de capacidade do contexto dedicado (`src/design-command.ts`, `src/verify-command.ts`, `src/design-prepare.ts`):**
     - Quando o contexto principal possui `capacity_policy_revision` diferente da do contexto dedicado, `resolvePersonalDesign` e `resolvePersonalVerification` atribuem a revisão pelo caminho do produto (`Capacity.assignPolicy`).
   - **3. Concorrência de design e verificação (`src/design-command.ts`, `src/personal-design-cli.ts`, `src/verify-command.ts`):**
     - `acquirePersonalDesign` converte `MANAGER_ACTIVE` no contexto dedicado em `Refusal('DESIGN_BUSY', 409)`. Em `src/personal-design-cli.ts`, `DESIGN_BUSY` recebeu mensagem clara em português e `runCreate` também marca `ac_intents` como `done` e libera o lease no `finally`.
     - `acquirePersonalVerify` converte `MANAGER_ACTIVE` no contexto dedicado em `Refusal('VERIFY_ALREADY_RUNNING', 409)`.
   - **6. `preparar --aplicar` em todos os contextos não arquivados (`src/design-prepare.ts`, `tests/design-prepare.test.ts`):**
     - `prepareDesignSpecialist` passou a listar todos os contextos não arquivados do projeto (incluindo o contexto principal já com política anterior e o contexto dedicado de exame) e atribuir a revisão via `Capacity.assignPolicy`, atualizando `tests/design-prepare.test.ts` para validar que o contexto anterior passa para a nova revisão.
   - **7. Restauração de login quando o Claude CLI apaga os tokens (`src/exam-login.ts`, `tests/exam-login.test.ts`):**
     - Em `prepareClaudeExamAccessToken`, o documento original inteiro (`originalText`, lido sob a trava antes de gravar `expiresAt: 0`) é restaurado atomicamente em modo `0600` e a chamada recusa com `EXAM_LOGIN_STALE` sempre que o documento após a renovação não tiver `accessToken` e `refreshToken` não vazios, `expiresAt` bom ou `accessToken` novo (mantendo proteção contra modificação externa concorrente entre a leitura pós-renovação e a restauração).
     - Adicionado teste em `tests/exam-login.test.ts` com renovador falso que grava `accessToken` e `refreshToken` vazios e `expiresAt: 0`, comprovando restauração idêntica ao original em modo `0600` e recusa `EXAM_LOGIN_STALE`.
   - **5. Novos testes de isolamento (`tests/exam-context-isolation.test.ts`, `tests/personal-design-cli-message.test.ts`):**
     - Adicionados testes com banco Postgres de teste cobrindo: gerente ativo no contexto principal com `criar` + `exame` rodando e reservando no contexto dedicado sem alterar o `epoch` do gerente principal; segunda execução simultânea recusando com `DESIGN_BUSY`; reuso do contexto dedicado na execução seguinte; `preparar --aplicar` atualizando contexto principal e contexto dedicado já existente; e verificação pessoal via CLI em contexto dedicado `verify` convivendo com gerente ativo e recusando concorrência com `VERIFY_ALREADY_RUNNING`.
2. **Commit deste relatório (`docs/RELATORIO-R10-A.md`)** — commit subsequente neste mesmo ramo.

## Testes

Executados após a última edição de código e testes, com credenciais sintéticas/falsas e `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`:

- `npx tsc --noEmit --skipLibCheck`: passou (0 erros).
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test tests/exam-context-isolation.test.ts tests/design-prepare.test.ts tests/personal-design-cli-message.test.ts tests/personal-design-cli.test.ts tests/personal-verify-cli.test.ts tests/verify-command.test.ts tests/exam-login.test.ts tests/ledger.test.ts`:
  - **59 testes passaram, 0 falharam, 0 ignorados.**
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test tests/design-intent-route.test.ts tests/verify-runtime.test.ts`:
  - **18 testes passaram, 0 falharam, 0 ignorados.**
- A suíte completa, o laboratório Docker e a instalação viva não foram tocados, conforme instrução da ordem.
