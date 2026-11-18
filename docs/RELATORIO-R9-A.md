# Relatório — Reconstrução do design, rodada 9 (Bloco A)

Trabalhador A, no worktree `/home/app/projects/agent-control-design-b` (ramo `task/design-r5-b`), executando `docs/ORDEM-DESIGN-RECONSTRUCAO-9.md`.

## Commits

1. **`122bc67e`** — `Protect pre-launch grant checks, drop launch files on resume, and test supervisor result redaction`
   - **1. Grant antes do `try` e `failBeforeLaunch` (`src/native-execution-supervisor.ts`, `tests/r5-native-real-worker-physical.test.ts`):**
     - `releaseBeforeLaunch` e `failBeforeLaunch` foram movidos para logo após a verificação inicial da reserva (`this.ledger.tx`) e a resolução de `synthetic`.
     - Todo o trecho entre a reserva e o `try` de pré-launch (`personal`, `ProviderEligibility.view`, `AccountHomes.inspectGranted`, `readMountedCredentialSecrets` / `assertCodexSubscriptionIdentity`, `assertNoNativeTaskSecrets`, `diskGuard.assertAdmission`, `this.directory` e `docker.imagePresent`) agora fica protegido por `try/catch`, chamando `failBeforeLaunch` e repropagando o erro original.
     - `failBeforeLaunch` deixou de engolir falhas de `releaseBeforeLaunch`: registra um evento JSON no `console.error` com `code` filtrado por `safeFailureCode(..., 'NATIVE_RELEASE_BEFORE_LAUNCH_FAILED')` (sem segredos), limpa `p.root` no `finally` se `jobDirCreated` for verdadeiro e repropaga o erro da liberação.
     - Em `tests/r5-native-real-worker-physical.test.ts`, como `assertNoNativeTaskSecrets` agora libera o grant ao recusar com `NATIVE_EXECUTION_SECRET_IN_TASK`, o teste foi ajustado para confirmar que o primeiro grant passa a `released` e reservar um novo grant para a chamada seguinte de `review.verification.run` (não executado aqui por ser teste de laboratório Docker).
   - **2. Retomada sem token antigo no disco (`src/native-execution-supervisor.ts`):**
     - `removeLaunchFiles` passou a apagar também eventuais arquivos `launch.pending.*` em `p.input`.
     - `resumeExecutionContainers` agora remove `payload.oauthAccessToken` em memória e chama `await this.removeLaunchFiles(input.jobId)` **antes** de preparar o login novamente.
     - Falhas durante a preparação Claude (`prepareClaudeExamAccessToken`, `assertNoNativeTaskSecrets`, `readPrivateWorkerFile`, `writeNativeSecretSnapshot`) ou durante a escrita/renomeação do novo `launch.json` — inclusive erros comuns (não `Refusal`) — limpam quaisquer arquivos residuais de launch, e retornam `{resumed: false, failureCode}` com código seguro via `safeFailureCode`, fazendo o job falhar e liberar o grant sem deixar `launch.json`/`launch.pending*` no disco.
   - **3. Testes de segredo pelo caminho real e cobertura dos itens 1–3 (`tests/verify-exam-worker-mount.test.ts`):**
     - Novo teste para falha injetada em `diskGuard.assertAdmission` e `AccountHomes.prototype.inspectGranted` liberando o grant e repropagando o erro original, além de falha em `releaseBeforeLaunch` dentro de `failBeforeLaunch` registrando o código seguro (sem o segredo) no `console.error` e repropagando o erro.
     - Novo teste de retomada (`resumeExecutionContainers`) com erro comum na preparação e com falha na escrita do novo launch (`worker-token` ausente), confirmando remoção de `launch.json`, `launch.pending` e `launch.pending.*`, falha do job com o código e liberação do grant.
     - Novo teste confirmando que o `execution-result.json` gravado pelo próprio supervisor em `reconcile` (via `writePrivateAtomic`) na falha da retomada contém o `failureCode` atualizado e não contém `accessToken` nem `refreshToken` falsos, mesmo com o CLI falso tentando vazar `CLAUDE_CODE_OAUTH_TOKEN` no output (redacionado pelo `ClaudeExecutionAdapter`) e com o token presente na mensagem do erro injetado na preparação.
2. **Commit de relatório (`docs/RELATORIO-R9-A.md`)** — commit subsequente neste mesmo ramo registrando este relatório.

## Testes

Executados após a última edição de código e testes, com credenciais falsas, binário `claude` falso e `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test`:

- `npx tsc --noEmit --skipLibCheck`: passou (0 erros).
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test --test-concurrency=4 tests/verify-exam-worker-mount.test.ts tests/native-execution-supervisor.test.ts tests/native-execution-repository-isolation.test.ts tests/native-retired-executor.test.ts tests/native-disk-wait.test.ts tests/design-intent-route.test.ts tests/exam-login.test.ts`:
  - **36 testes passaram, 0 falharam, 0 ignorados.**
- Suíte completa, laboratório Docker e `tests/r5-native-real-worker-physical.test.ts` (que usa `remoteDevelopmentLab` / Docker) não foram executados, conforme instrução da ordem.
