# Relatório — Reconstrução do design, rodada 5 (Bloco A)

Trabalhador A, no worktree `/home/app/projects/agent-control-design` (ramo `task/design-r3-image-proof`).

## Commits

1. **`33837c48`** — Item 1a (`src/exam-login.ts`, `src/native-execution-supervisor.ts`, `tests/exam-login.test.ts`):
   - Alterado `EXAM_LOGIN_MARGIN_MS` para `5 * 60 * 1000` (5 min); `examLoginNeedsRefresh` só renova quando `expiresAt` está ausente, ilegível ou com menos de 5 min restantes.
   - Adicionada `examLoginFreshAfterRenew`: após a renovação, exige `expiresAt > now + 5 min`, senão recusa com `EXAM_LOGIN_STALE`.
   - Teste cobrindo token com 20 min restantes (não renova e não recusa) e fronteira exata de 5 min após renovação.

2. **`f1e88917`** — Item 1b (`src/exam-login.ts`, `tests/exam-login.test.ts`):
   - `renewClaudeLoginInPlace` agora cria diretório temporário novo, vazio e `0o700`, executa nele com `cwd` e `TMPDIR` apontando para esse diretório, remove-o em `finally`, passa `--setting-sources user`, `--strict-mcp-config`, `--mcp-config '{"mcpServers":{}}'`, `--max-turns 1`, e ambiente restrito a `PATH`, `HOME`, `CLAUDE_CONFIG_DIR` e `TMPDIR`.
   - Teste com binário falso (`AC_NATIVE_CLAUDE_BIN`) registrando `cwd`, permissões, conteúdo vazio, `argv` e `env`, além de verificar limpeza após sucesso e falha.

3. **`a6de674b`** — Item 1c (`src/exam-login.ts`, `src/native-execution-supervisor.ts`, `tests/exam-login.test.ts`, `tests/verify-exam-worker-mount.test.ts`):
   - Adicionada trava por conta via `postgresAccountLoginLock` (`pg_advisory_xact_lock(hashtextextended($1, 90))` com `accountId`) usada em `ensureExamLoginFresh` e `applyReturnedExamCredential`.
   - Ao obter a trava, `ensureExamLoginFresh` relê `.credentials.json` e não renova novamente se outro processo já renovou.
   - Antes de montar a cópia, `NativeExecutionSupervisor.start` registra em memória (`examRefreshMarks`) o hash SHA-256 do `refreshToken` atual (`readClaudeRefreshTokenHash`), sem gravar em disco, passar ao worker ou registrar em logs.
   - `applyReturnedExamCredential` exige trava, correspondência do hash do `refreshToken` atual com a marca de partida, `expiresAt` devolvido estritamente maior que o atual, `refreshToken` diferente do atual e igualdade de `scopes`, `subscriptionType` e `rateLimitTier` (além de eventuais campos UUID), gravando somente `accessToken`, `refreshToken` e `expiresAt` em `claudeAiOauth` e preservando todas as demais chaves do arquivo atual.
   - `settleExamCredential` reescreve `execution-result.json` sem `examCredential` antes de aplicar/recusar, garantindo que o token nunca permaneça no disco do job em caso de falha.
   - `readExamCredentialReturn` também só retorna credencial quando houve rotação de `refreshToken` com `expiresAt` maior e mesma conta.
   - Testes no formato real (sem `accountUuid`/`uuid`): devolução válida, arquivo trocado no meio, `expiresAt` menor, chave extra ignorada, duas devoluções concorrentes (só uma grava), releitura sob trava e limpeza de `execution-result.json` na falha.

4. **`647c7dd8`** — Item 1d (`src/native-execution-supervisor.ts`, `tests/verify-exam-worker-mount.test.ts`):
   - Recusa por `EXAM_LOGIN_STALE` em `NativeExecutionSupervisor.start` agora libera o grant reservado em `ac_capacity_grants` (`state='released'`, `physical_receipt` com `reason: 'exam_login_stale'`), seguindo o mesmo padrão do ramo `NATIVE_IMAGE_MISSING`.
   - Teste verificando que o grant fica `released` e não preso após recusa por `EXAM_LOGIN_STALE`.

## Testes rodados

Após o último commit funcional (`647c7dd8`):

- `npx tsc --noEmit`: passou sem erros (código de saída 0).
- `node --import tsx --test tests/exam-login.test.ts tests/verify-exam-worker-mount.test.ts`:
  - 17 testes listados: 16 passaram, 0 falharam, 1 ignorado (`SKIP`).
  - O teste ignorado (`postgresAccountLoginLock serializa duas devoluções concorrentes entre conexões Postgres reais`) depende de `AC_TEST_DATABASE_URL`, que não foi usada nesta etapa conforme a ordem de execução por bloco.

## Risco residual conhecido

- Um worker comprometido poderia devolver tokens de outra conta com os mesmos `scopes`, `subscriptionType` e `rateLimitTier` (e sem campos UUID divergentes), pois essas propriedades não identificam univocamente a conta quando `accountUuid`/`uuid` estão ausentes.

## O que não ficou pronto / fica para o gerente

- Itens dos blocos B (itens 2 e 5) e C (itens 3 e 4).
- Execução do teste de concorrência real com `postgresAccountLoginLock` contra Postgres (`AC_TEST_DATABASE_URL`).
- Suíte completa (`npm test` com `AC_TEST_DATABASE_URL`), laboratório Docker (`AC_DESIGN_LAB=1`) e eventual reconstrução de imagem do worker (já que `src/exam-login.ts`, importado por `src/native-execution-worker.ts`, foi atualizado), conforme instruído na ordem.
