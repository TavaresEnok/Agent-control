# Relatório — Reconstrução do design, rodada 8 (Bloco A)

Trabalhador A, no worktree `/home/app/projects/agent-control-design-b` (ramo `task/design-r5-b`), executando `docs/ORDEM-DESIGN-RECONSTRUCAO-8.md`.

## Commits

1. **`4598592a`** — `Finish Claude exam login hardening: launch cleanup, atomic checks, resume, and secret tests`
   - **1. Remoção do token em disco (`src/native-execution-supervisor.ts`):**
     - Adicionado `removeLaunchFiles(jobId)` removendo `input/launch.json` e `input/launch.pending`.
     - `reconcile` remove esses arquivos quando conclui/falha um job e também ao reconciliar jobs já `completed` ou `failed` após reinício do supervisor.
     - `retireTerminal`, `retireManagedWriter` e `recover` (no retorno `released_unstarted`) também garantem a remoção de `launch.json`/`launch.pending`.
   - **2. Comparação antes de gravar e falha explícita na restauração (`src/exam-login.ts`, `src/personal-design-cli.ts`, `src/personal-verify-cli.ts`, `src/design-examine.ts`, `src/design-create.ts`):**
     - `prepareClaudeExamAccessToken` relê `.credentials.json` imediatamente antes de gravar `claudeAiOauth.expiresAt = 0`; se o arquivo mudou desde a leitura inicial, não grava `expiresAt = 0` e reavalia com o documento novo (retornando `fresh` sem renovar se já estiver bom).
     - Na restauração após falha de renovação, só restaura `expiresAt` após releitura imediata confirmando que `refreshToken` e `accessToken` ainda são os originais.
     - Se a gravação (ou releitura) da restauração falhar, o erro não é engolido e recusa com `EXAM_LOGIN_RESTORE_FAILED` e frase fixa `EXAM_LOGIN_RESTORE_FAILED_TEXT`, sem token, propagada nas CLIs e fluxos de design/validação.
   - **3. Sucesso da renovação sem exigir rotação de `refreshToken` (`src/exam-login.ts`):**
     - A renovação passa a ser aceita quando `expiresAt > now + examMaxMs + 10 min` e `accessToken` mudou para um valor não vazio, independentemente de `refreshToken` ter mudado ou não.
   - **4. Liberação do grant e limpeza do diretório em toda falha antes do launch (`src/native-execution-supervisor.ts`):**
     - Todo o trecho entre a definição de `releaseBeforeLaunch` e `serialEffect` (incluindo verificação de modelo solicitado, `admitNativeResources`, inserção `uncertain`, preparação de token Claude, `jobRepository`, `mkdir`, `request.json`, snapshot Git, `stageDesignCapturesForJob`, chaves/tokens, `cp`, `stripExamHostileConfig`, diff, `writeNativeSecretSnapshot` e `mkdir(toolsWork)`) fica protegido para chamar `releaseBeforeLaunch(reason)` e remover `p.root` se já criado (o mesmo em `DOCKER_CREATE_REFUSED` quando o grant é liberado).
   - **5. Grupo do renovador (`src/exam-login.ts`):**
     - `renewClaudeLoginInPlace` passa a enviar `killGroup('SIGKILL')` (`process.kill(-child.pid, 'SIGKILL')`, ignorando `ESRCH`) sempre no evento `exit` do processo líder, antes de resolver/rejeitar, remover o diretório temporário e soltar a trava.
   - **6. Outras fontes de login (`src/native-execution-worker.ts`, `src/verify-exam-isolation.ts`):**
     - Removidas também `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` e qualquer variável `CLAUDE_CODE_USE_*` tanto em `prepareClaudeExamWorkerEnv` quanto no wrapper `ac-exam-claude.cjs`.
   - **7. Retomada (`src/native-execution-supervisor.ts`):**
     - `resumeExecutionContainers` em exames Claude descarta o `oauthAccessToken` antigo, roda novamente `prepareClaudeExamAccessToken` (com trava e renovação) e `assertNoNativeTaskSecrets`, atualiza `oauthAccessToken`, `credentialSnapshotTag` e `redaction.enc`, e assina atomicamente um `launch.json` novo.
     - Se a preparação recusar (`Refusal`), não reinicia os contêineres, grava o `failureCode` da recusa em `execution-result.json`, remove `launch.json` e sela o job como `failed` (liberando o grant) com o código da recusa.
   - **8. Fixture sintética coerente (`src/native-execution-supervisor.ts`, `src/native-execution-worker.ts`):**
     - Supervisor e worker concordam que `syntheticFixture` não usa o caminho `claudeExam`: o supervisor remove `AC_VERIFY_EXAM=` de `workerEnv` e marca `synthetic: true` no `launch.json`, e o worker usa `isClaudeExamWorker({verifyExam, provider, synthetic})` que retorna `false` quando `synthetic` é verdadeiro.
   - **9. Testes de segredo e regressão (`tests/exam-login.test.ts`, `tests/verify-exam-worker-mount.test.ts`):**
     - Cobertura completa dos 9 itens com credenciais falsas e binário `claude` falso.
2. **Report commit (`docs/RELATORIO-R8-A.md`)** — commit subsequente neste mesmo ramo registrando este relatório.

## Testes

Executados após a última edição de código e testes, com credenciais falsas, binário `claude` falso e `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`:

- `npx tsc --noEmit --skipLibCheck`: passou (0 erros).
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test --test-concurrency=4 tests/exam-login.test.ts tests/verify-exam-worker-mount.test.ts tests/verify-exam-isolation.test.ts tests/design-exam-isolation.test.ts tests/native-execution-supervisor.test.ts tests/design-examine.test.ts tests/design-model-failure.test.ts tests/personal-design-cli-message.test.ts tests/personal-verify-cli.test.ts tests/claude-quota-wait.test.ts tests/r3-synthetic-capability.test.ts tests/design-create-sanitize.test.ts`:
  - **105 testes passaram, 0 falharam, 0 ignorados**, cobrindo:
    - remoção de `launch.json`/`launch.pending` no término do job, retirada (`retireTerminal`), recuperação sem início (`released_unstarted`), falha antes do launch e `reconcile` após reinício do supervisor;
    - releitura antes de gravar `expiresAt=0` (reavaliação sem renovar quando o arquivo mudou para token bom), comparação de `refreshToken` + `accessToken` originais na restauração e recusa `EXAM_LOGIN_RESTORE_FAILED` com frase fixa sem token quando a restauração falha;
    - sucesso da renovação com `accessToken` novo e `expiresAt` válido sem rotação de `refreshToken`, e recusa quando `accessToken` não muda;
    - falha injetada em `stageDesignCapturesForJob` liberando o grant e apagando o diretório do job;
    - `SIGKILL` ao grupo do renovador após `exit` normal do líder que deixou processo filho vivo, antes de soltar a trava;
    - remoção de `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` e `CLAUDE_CODE_USE_*` no ambiente do worker e do wrapper do exame;
    - `resumeExecutionContainers` no exame Claude re-preparando token novo com renovação/re-assinatura e falhando o job com o código da recusa (`EXAM_LOGIN_STALE`) quando a preparação recusa;
    - concordância entre supervisor e worker (`isClaudeExamWorker`) sobre `claudeExam === false` com `syntheticFixture`;
    - ausência do `accessToken` falso em `execution-result.json`, nos logs redacionados do supervisor (`worker-terminal.log` e `tools-terminal.log`), nos relatórios do design e do validador, e nos argumentos de `docker create`.
- Suíte completa e laboratório Docker não executados, conforme instrução da ordem.

## Risco residual

- O `accessToken`, que dura pouco, fica visível ao processo do exame enquanto ele roda.
- O snapshot de redação (`redaction.enc`) guarda os segredos da conta cifrados.
