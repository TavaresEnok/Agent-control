# Relatório — Reconstrução do design, rodada 7 (Bloco A)

Trabalhador A, no worktree `/home/app/projects/agent-control-design-b` (ramo `task/design-r5-b`), executando `docs/ORDEM-DESIGN-RECONSTRUCAO-7.md`.

## Commits

1. **`06c86dde`** — `Deliver only accessToken to Claude exam, renew in place, and drop write-back`
   - **Sem `refreshToken` nem `.credentials.json` no exame Claude (`src/native-execution-supervisor.ts`, `src/native-execution-worker.ts`, `src/verify-exam-isolation.ts`):**
     - `NativeExecutionSupervisor.start` não monta `/account` (nem `.credentials.json`) para exames Claude (`readonlyExamIsolation && provider === 'claude' && !syntheticFixture`).
     - O host prepara e lê o `accessToken` sob a trava por conta (`postgresAccountLoginLock` com `lock_timeout = '120s'`) e o envia no payload assinado Ed25519 de `/input/launch.json` (`oauthAccessToken`), usando o mesmo canal privado do launch e incluindo o token (e segredos da conta no host) em `redaction.enc` e `assertNoNativeTaskSecrets`.
     - No worker, `prepareClaudeExamWorkerEnv` verifica `credentialSnapshotTag`, cria um `HOME` temporário sem credencial (`prepareExamClaudeHome`, contendo apenas `.claude/settings.json` com regras `Read`/`Grep`/`Glob` deny), remove `CLAUDE_CONFIG_DIR` e `ANTHROPIC_API_KEY` (também removidos no wrapper `ac-exam-claude.cjs`), e passa apenas `CLAUDE_CODE_OAUTH_TOKEN` ao CLI do exame.
     - Se o token vencer durante o job, `ClaudeExecutionAdapter` falha com `PROVIDER_AUTH_FAILED` sem vazar o segredo.
   - **Renovação forçada no lugar sob a trava (`src/exam-login.ts`):**
     - `prepareClaudeExamAccessToken` (e `ensureExamLoginFresh`) roda inteiramente sob a trava por conta e recalcula `Date.now()`:
       1. Se `expiresAt > now + examMaxMs + 10 min` (`EXAM_LOGIN_MARGIN_MS = 10 * 60 * 1000`, `DEFAULT_EXAM_MAX_MS = 15 * 60 * 1000`) e há `accessToken`, devolve o atual sem renovar.
       2. Caso contrário, grava atomicamente (`0600`, mesmo dono, sem seguir symlink) `claudeAiOauth.expiresAt = 0` preservando todo o restante do documento e executa o renovador (`renewClaudeLoginInPlace`).
       3. Exige `refreshToken` alterado, `expiresAt > afterNow + examMaxMs + 10 min` e `accessToken` não vazio. Se `refreshToken` não mudou, restaura o `expiresAt` original e recusa com `EXAM_LOGIN_STALE`; se `refreshToken` mudou mas `expiresAt` não ficou bom, não toca mais no arquivo e recusa com `EXAM_LOGIN_STALE`.
       4. Normaliza e relê o `accessToken` novo ainda sob a trava antes de soltá-la.
     - `renewClaudeLoginInPlace` agora executa o processo em grupo próprio (`detached: true`) e, ao estourar o tempo, envia `SIGTERM` ao grupo (`-pid`), aguarda `5_000` ms, envia `SIGKILL` ao grupo e espera `exit` antes de apagar o diretório temporário e soltar a trava.
   - **Liberação do grant antes do launch (`src/native-execution-supervisor.ts`):**
     - `releaseBeforeLaunch` agora aceita tanto `reserved` quanto `uncertain` (cancelando admissões preparadas quando aplicável e checando ausência de contêineres/rede).
     - Toda recusa antes do launch (`EXAM_LOGIN_STALE`, `EXAM_LOGIN_BUSY`, falha ao ler token, `NATIVE_EXECUTION_SECRET_IN_TASK`, falha antes de criar contêineres) libera o grant mesmo depois de o job ter ficado `uncertain`.
     - `design-create.ts` também propaga `EXAM_LOGIN_BUSY` junto de `EXAM_LOGIN_STALE`.

## O que foi removido

Retirada toda a máquina de devolução de credencial da cópia em código, CLI e testes:

- `examCredential` do schema `Result` e da saída `execution-result.json` (`src/native-execution-supervisor.ts`, `src/native-execution-worker.ts`);
- `readExamCredentialReturn`, `applyReturnedExamCredential`, `classifyReturnedCredential`, `recoverExamCredential`, `recoverAccountCredentialCommand`, `hashExamRefreshToken`, `readClaudeRefreshTokenHash`, `writeExamRefreshMark`, `readExamRefreshMark`, `snapshotClaudeExamAccountUnderLock`, `markExamRecoverySaved`, `examLoginRecoveryNote` e `EXAM_LOGIN_RECOVERY_TEXT` (`src/exam-login.ts`);
- `settleExamCredential`, `examRefreshMark`, `removeExamRefreshMark` e `examAccountSnapshot` (`src/native-execution-supervisor.ts`);
- `rememberExamRecoveryNote` e `takeExamRecoveryNote` (`src/exam-strip-note.ts`);
- subcomando `account-recover` (`src/server-main.ts`);
- propagação e exibição de recuperação em `src/design-examine.ts`, `src/design-module.ts`, `src/personal-design-cli.ts`, `src/personal-verify-cli.ts`, `src/verify-command.ts` e `src/verify-runtime.ts`;
- testes legados de devolução/recuperação em `tests/exam-login.test.ts` e `tests/verify-exam-worker-mount.test.ts`.

## Testes

Todos executados após a última edição de código, com credenciais falsas, binário `claude` falso e `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`:

- `npx tsc --noEmit --skipLibCheck`: passou (0 erros).
- `AC_TEST_DATABASE_URL=... node --import tsx --test tests/exam-login.test.ts tests/verify-exam-worker-mount.test.ts tests/verify-exam-isolation.test.ts tests/design-exam-isolation.test.ts tests/design-model-failure.test.ts tests/exam-strip-note.test.ts tests/design-native-launch.test.ts tests/verify-native-launch.test.ts tests/design-examine.test.ts tests/design-module.test.ts tests/personal-design-cli-message.test.ts tests/personal-verify-cli.test.ts tests/claude-quota-wait.test.ts`:
  - **70 testes passaram, 0 falharam, 0 ignorados**, cobrindo:
    - token com 3 h de validade sem chamar renovador e entregue por `CLAUDE_CODE_OAUTH_TOKEN`;
    - token perto de vencer gravando `expiresAt: 0`, renovação forçada com rotação de `refreshToken` e entrega do novo `accessToken`;
    - falha do renovador restaurando `expiresAt` original e recusando com `EXAM_LOGIN_STALE` (e caso em que `refreshToken` gira com `expiresAt` insuficiente sem tocar mais no arquivo);
    - renovador ignorando `SIGTERM` com processo filho no mesmo grupo, recebendo `SIGTERM`/`SIGKILL` no grupo e soltando a trava somente após `exit`;
    - serialização em Postgres real (`postgresAccountLoginLock`) e `lock_timeout = '120s'` -> `EXAM_LOGIN_BUSY`;
    - ausência de `.credentials.json` em `/account` e `/tmp` no worker do exame, presença de `CLAUDE_CODE_OAUTH_TOKEN` e ausência de `CLAUDE_CONFIG_DIR` e `ANTHROPIC_API_KEY`;
    - liberação do grant para `EXAM_LOGIN_STALE`, `EXAM_LOGIN_BUSY` e falha ao ler o token após `uncertain`;
    - segredo ausente de logs (`redaction.enc` + `redactNativeDockerLogs`), relatórios, `execution-result.json`, saída do `ClaudeExecutionAdapter` e linha de comando (`argv`);
    - uso do mesmo mecanismo pelos dois caminhos do validador (`specialist`, `reviewer`) e pelos três caminhos do design (`specialist`, `reviewer`, `criar`).
- `AC_TEST_DATABASE_URL=... node --import tsx --test tests/native-execution-supervisor.test.ts tests/native-execution-redaction.test.ts tests/design-create-sanitize.test.ts`:
  - **53 testes passaram, 0 falharam** (`tests/design-reconstruction.test.ts` não rodou neste worktree por depender de `deploy/design-tools/node_modules`).
- Suíte completa e laboratório Docker não executados, conforme instrução da ordem.

## Risco residual

- O `accessToken`, de curta duração, fica visível ao processo do exame, protegido pela negação de leitura de `/proc`.
