# Relatório — reconstrução do design, rodada 11 (trabalhador A)

Executado conforme [ORDEM-DESIGN-RECONSTRUCAO-11.md](docs/ORDEM-DESIGN-RECONSTRUCAO-11.md) no worktree `/home/app/projects/agent-control-design-b` (ramo `task/design-r5-b`).

## Resumo das alterações

1. **Wrapper fixo do exame na imagem (`deploy/ac-exam-claude.cjs`, `deploy/Dockerfile.native-execution`, `scripts/native-image-builder.mjs`, `src/verify-exam-isolation.ts`, `src/native-execution-worker.ts`)**
   - Criado `deploy/ac-exam-claude.cjs` com o mesmo conteúdo de `examClaudeWrapperSource('/usr/local/bin/claude')` e shebang `#!/usr/bin/env node`.
   - `deploy/Dockerfile.native-execution` passa a copiar `ac-exam-claude.cjs` para `/usr/local/bin/ac-exam-claude` com `--chmod=0755` antes de `USER node`.
   - `scripts/native-image-builder.mjs` copia `deploy/ac-exam-claude.cjs` para o contexto de build da imagem `execution`.
   - `src/verify-exam-isolation.ts` exporta `EXAM_CLAUDE_WRAPPER_BIN = '/usr/local/bin/ac-exam-claude'` e mantém `installExamClaudeWrapper` para testes de host com `process.execPath`.
   - `src/native-execution-worker.ts` não importa nem chama `installExamClaudeWrapper` em `/tmp`; `prepareClaudeExamWorkerEnv` retorna `EXAM_CLAUDE_WRAPPER_BIN` e `main` passa esse caminho a `ClaudeCliRunner` via `createClaudeWorkerRunner`.

2. **Falhas legíveis nos adaptadores Claude (`src/claude-planning-adapter.ts`, `src/claude-execution-adapter.ts`)**
   - Adicionados `claudeSpawnFailureCode` (`CLAUDE_SPAWN_<CÓDIGO>` em maiúsculas, cobrindo `EACCES`, `EPERM`, `ENOENT`, etc., inclusive mensagem `not found on PATH` do `ClaudeCliRunner`), `claudeExitFailureCode` (`CLAUDE_EXIT_FAILED` quando há erro de saída do CLI sem código de provedor reconhecido) e `logClaudeAdapterFailure` / `formatClaudeAdapterFailureLine`.
   - No `catch` (e nos desvios de limite/autenticação) de `ClaudeExecutionAdapter` e `ClaudePlanningAdapter`, além de lançar a falha classificada, escreve no `stderr` uma linha `CLAUDE_ADAPTER_FAILURE <código> <mensagem>` com segredos redigidos (`redactSecrets`), caracteres fora de `[A-Za-z0-9_ .:,/-]` removidos e no máximo 200 caracteres na mensagem.

3. **Restauração quando `.credentials.json` some durante a renovação (`src/exam-login.ts`)**
   - `writePrivateAtomic` aceita `{allowCreate?: boolean}` para recriar arquivo ausente (`ENOENT`) com arquivo temporário `0600`, `sync`, preservação de dono do diretório, `link`/`unlink` sem seguir symlinks (recusando symlink plantado).
   - `prepareClaudeExamAccessToken` usa `{allowCreate: afterText === undefined}` quando `restoreText === afterText`, restaurando o documento original e recusando com `EXAM_LOGIN_STALE` em vez de `EXAM_LOGIN_RESTORE_FAILED`.

4. **Finalização uniforme de intenções de exame e desbloqueio do `selectForNew` (`src/exam-intent.ts`, `src/personal-design-cli.ts`, `src/personal-verify-cli.ts`, `src/design-command.ts`, `src/verify-runtime.ts`, `src/workflow-generations.ts`)**
   - Criado `src/exam-intent.ts` com `finishExamIntent`, `finishExamIntentTx` e `withExamSignals` (`SIGINT` e `SIGTERM`).
   - `personal-design-cli.ts` (`runDesignSession` para exame de design e `criar`), `personal-verify-cli.ts` (`runPersonalVerifySession`) e `verify-runtime.ts` (`runSecurityVerification`) encerram a intenção em `done` no sucesso e em `failed` em qualquer falha, exceção ou `SIGINT`/`SIGTERM`, no mesmo caminho compartilhado.
   - `WorkflowGenerations.selectForNew` em `src/workflow-generations.ts` exclui contextos presentes em `ac_exam_contexts` da checagem de `WORKFLOW_LEGACY_RETENTION_REQUIRED`.

## Verificações executadas

- `npx tsc --noEmit --skipLibCheck`: passou (código de saída `0`).
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test --test-concurrency=1 tests/verify-exam-isolation.test.ts tests/design-exam-isolation.test.ts tests/claude-quota-wait.test.ts tests/exam-login.test.ts tests/exam-context-isolation.test.ts tests/personal-design-cli-message.test.ts tests/verify-exam-worker-mount.test.ts`: 51/51 passaram.
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test --test-concurrency=1 tests/personal-design-cli.test.ts tests/personal-verify-cli.test.ts tests/verify-runtime.test.ts tests/verify-command.test.ts tests/design-model-failure.test.ts`: 41/41 passaram.
- Nota: `tests/workflow-generations.test.ts` não roda neste worktree porque `upstream/happier/node_modules/.agent-control-boundary.mjs` não está construído aqui; por isso o teste de `selectForNew` sobre `ac_exam_contexts` foi adicionado e executado em `tests/exam-context-isolation.test.ts`.
