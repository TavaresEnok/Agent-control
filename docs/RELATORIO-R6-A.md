# Relatório — Reconstrução do design, rodada 6 (Bloco A)

Trabalhador A, no worktree `/home/app/projects/agent-control-design-b` (ramo `task/design-r5-b`).

## Commits

1. **`962c8f2a`** — Itens 1 a 5 do Bloco A (`src/exam-login.ts`, `src/exam-strip-note.ts`, `src/native-execution-supervisor.ts`, `src/server-main.ts`, `src/design-examine.ts`, `src/design-module.ts`, `src/personal-design-cli.ts`, `src/verify-runtime.ts`, `src/verify-command.ts`, `src/personal-verify-cli.ts`, `tests/exam-login.test.ts`, `tests/verify-exam-worker-mount.test.ts`):
   - **Item 1 (snapshot e marca sob a trava, junto da montagem):**
     - `snapshotClaudeExamAccountUnderLock` em `src/exam-login.ts` lê `.credentials.json` sob `postgresAccountLoginLock` junto da montagem em `NativeExecutionSupervisor.start`, calcula o hash SHA-256 do `refreshToken`, extrai os segredos de redação/`credentialSnapshotTag` do mesmo conteúdo e materializa `<jobRoot>/exam-account-<accountId>` (0700/0600, sem seguir symlinks) montado em `:/account:ro` no worker.
     - Teste em `tests/verify-exam-worker-mount.test.ts` cobrindo troca do arquivo entre a pré-checagem e a montagem e confirmando que o snapshot montado e a marca correspondem ao arquivo trocado.
   - **Item 2 (marca persistente em disco 0600):**
     - Removido o `Map` em memória (`examRefreshMarks`) de `NativeExecutionSupervisor`.
     - `writeExamRefreshMark` e `readExamRefreshMark` gravam/lêem somente o hash SHA-256 de 64 hex (nunca o token) em `<jobRoot>/exam-refresh-mark` (modo 0600, `O_NOFOLLOW`, exclusivo do host).
     - `reconcile` após reinício (novo `NativeExecutionSupervisor`) lê o arquivo da marca e devolve corretamente; a marca é removida no término do job (com ou sem `examCredential`), em `retireTerminal`, em falha antes da criação dos contêineres (`DOCKER_CREATE_REFUSED`) e em `recover` quando `released_unstarted`.
   - **Item 3 (recuperação em vez de perda e `account-recover`):**
     - `applyReturnedExamCredential` grava `<accountDir>/.exam-credential-recovery-<jobId>.json` (0600, escrita atômica via temporário exclusivo `O_NOFOLLOW`, sem seguir symlink) quando a devolução é recusada por hash diferente da marca, marca ausente, `expiresAt` não maior, falha de escrita ou falha na trava (`EXAM_LOGIN_BUSY`). Documentos inválidos (JSON ruim ou sem `accessToken`/`refreshToken`) são descartados.
     - `settleExamCredential`, `examLoginRecoveryNote`, `rememberExamRecoveryNote`/`takeExamRecoveryNote`, `design-examine.ts`, `design-module.ts`, `personal-design-cli.ts`, `verify-runtime.ts`, `verify-command.ts` e `personal-verify-cli.ts` propagam e exibem a frase fixa sem o token no relatório do job e na CLI: `"O login renovado no exame foi guardado para recuperação; rode \`npm run gateway -- account-recover\` ou entre de novo"`.
     - `recoverExamCredential` e `recoverAccountCredentialCommand` (`npm run gateway -- account-recover <instalação> <accountId>` em `src/server-main.ts`) executam sob `postgresAccountLoginLock`, escolhem a recuperação da mesma conta com maior `expiresAt` estritamente maior que o atual, aplicam apenas `accessToken`, `refreshToken` e `expiresAt` e removem os arquivos de recuperação.
     - Testes em `tests/exam-login.test.ts` e `tests/verify-exam-worker-mount.test.ts` cobrindo cada motivo de recusa, descarte de inválido, recusa a symlink no arquivo de recuperação, `account-recover`, relatório e CLI.
   - **Item 4 (identidade):**
     - `classifyReturnedCredential` agora só trata `subscriptionType` e `rateLimitTier` como divergência (`other-account`) quando existem nos dois lados e diferem; o aparecimento ou desaparecimento desses campos não recusa a devolução. `scopes` continua exigindo igualdade.
     - Testes em `tests/exam-login.test.ts`.
   - **Item 5 (renovador e trava):**
     - `renewClaudeLoginInPlace` envia `SIGTERM` ao atingir o tempo limite (padrão `90_000` ms), aguarda `5_000` ms (configurável em teste), envia `SIGKILL` se ainda vivo e **espera o evento `exit`** (ou `error`) antes de remover o diretório temporário e retornar para soltar a trava. Testado com binário falso que ignora `SIGTERM`.
     - `ensureExamLoginFresh` recalcula `Date.now()` (ou `clock()`) dentro da trava e após o renovador. Testado em `tests/exam-login.test.ts`.
     - `postgresAccountLoginLock` executa `SET LOCAL lock_timeout = '120s'` na transação e converte timeout de trava (`55P03` / `lock timeout`) em `Refusal('EXAM_LOGIN_BUSY', 409)` com `EXAM_LOGIN_BUSY_TEXT` no relatório/CLI. Testado em `tests/exam-login.test.ts`.

## Verificações executadas após o último código

- `npx tsc --noEmit --skipLibCheck`: passou (código de saída 0). *(Para resolução dos imports de `upstream/cezar` no worktree, foram criados symlinks gitignorados `upstream/cezar/node_modules` e `upstream/cezar/packages/cezar/dist` apontando para os artefatos já compilados em `/home/app/projects/agent-control-design`, sem alterar o outro worktree.)*
- `node --import tsx --test tests/exam-login.test.ts tests/verify-exam-worker-mount.test.ts tests/design-exam-isolation.test.ts tests/verify-exam-isolation.test.ts tests/exam-strip-note.test.ts tests/design-model-failure.test.ts tests/personal-design-cli-message.test.ts tests/design-examine.test.ts tests/design-module.test.ts tests/personal-verify-cli.test.ts`:
  - 59 testes listados: 58 passaram, 0 falharam, 1 ignorado (`SKIP`: `postgresAccountLoginLock serializa duas devoluções concorrentes entre conexões Postgres reais`, que requer `AC_TEST_DATABASE_URL`).
- `node --import tsx --test tests/personal-design-cli.test.ts tests/personal-verify-cli.test.ts`:
  - 12 passaram, 0 falharam.
- `node --import tsx --test tests/design-native-launch.test.ts tests/verify-native-launch.test.ts tests/verify-command.test.ts`:
  - 21 passaram; 2 testes em `tests/verify-command.test.ts` (`o exame grava andamento, espera as ferramentas e conta chamadas` e `prazo esgotado não chama ferramentas nem o worker`) falharam apenas por exigirem `AC_TEST_DATABASE_URL` no ambiente.

## O que fica para o gerente

- Integrar os ramos dos Blocos A (`task/design-r5-b`) e C (`task/design-r5-c`).
- Rodar a suíte completa com Postgres (`AC_TEST_DATABASE_URL`) e o laboratório Docker (`AC_DESIGN_LAB=1`), além de eventual reconstrução das imagens nativas se aplicável.
