# Relatório — Rodada 14 (fechar achados da revisão de `e92a26f6`)

Executado conforme `/home/app/projects/agent-control/docs/ORDEM-FINAL-A1-R14.md` no worktree `/home/app/projects/ac-wt/final-a1-r13` (ramo `task/final-a1-r13`, a partir de `56b0e3b4`).

## Correções implementadas

1. **Achados históricos sem identidade original e achados de ferramenta verificáveis (`src/verify-remediate.ts`, `src/verify-api.ts`, `src/personal-verify-cli.ts`, `src/verify-runtime.ts`)**
   - `recheckFindings` e `reviewFinding` (`src/verify-remediate.ts`) recusam fechar ou alterar achados sem `examiner_profile_id` registrado (dados históricos sem identidade inventada), preservando o achado intacto no banco e nos relatórios e lançando `VerifyRecheckRefusal` (`VERIFY_RECHECK_NEW_EXAM_REQUIRED`, HTTP `409`) com orientação explícita (`VERIFY_RECHECK_NEW_EXAM_GUIDANCE`) para executar novo exame de segurança.
   - A rota `POST /api/v1/ac/personal/verificacoes/:runId/reverificar` (`src/verify-api.ts`) devolve `409` com `{ error: 'VERIFY_RECHECK_NEW_EXAM_REQUIRED', guidance }` e `verifyCliFailureText` (`src/personal-verify-cli.ts`) mapeia o código para a mesma orientação.
   - Quando a intenção original de `ac_verify_runs` já está terminal (`done`, `failed`, etc.), `recheckFindings` abre uma nova intenção `security-verify-readonly-v1` via `acceptSecurityVerification` e a finaliza via `finishExamIntent` ao término, permitindo reverificar execuções reais concluídas por `runSecurityVerification`.
   - Em `runSecurityVerification` (`src/verify-runtime.ts`), novos achados de ferramenta (`rawFindings`) passam a persistir `examiner_profile_id = mapProfileId` e `examiner_account_id = mapAccountId`, de forma coerente com a exclusão da etapa de mapa usada na confirmação inicial, tornando-os reverificáveis sem atribuir identidade inventada a registros históricos.

2. **Limpeza idempotente de `releaseGrant` sem engolir erro e remoção da janela pós-reserva (`src/capacity.ts`, `src/exam-provider.ts`)**
   - `Capacity.reserveWithSeat` (`src/capacity.ts`) compartilha a transação de `reserve` (`reserveModelGrant`) e lê `provider` e `model` dentro da própria transação antes do commit, eliminando a janela da consulta pós-reserva em `exam-provider.ts`.
   - Em `acceptReservedSeat` / `releaseReservedGrant` (`src/exam-provider.ts`), falhas de validação pós-reserva executam `releaseGrant` (idempotente via `Capacity.transition` para `released`) com tentativa limitada (`MAX_RELEASE_ATTEMPTS = 3`) para erros transitórios e falha rápida para erros determinísticos (`Refusal` / `ZodError`). Se a limpeza falhar de forma persistente, ambas as causas são preservadas em `AggregateError([originalError, lastReleaseError], 'EXAM_SEAT_RELEASE_FAILED')`.

3. **Precedência de `preferredProfileId` preservada e distinção entre conta do examinador e conta do 1º revisor (`src/capacity.ts`, `src/exam-provider.ts`, `src/verify-types.ts`, `src/verify-remediate.ts`, `src/verify-native-launch.ts`)**
   - `Capacity.reserve` mantém o contrato original para `preferredProfileId` e demais chamadores (`avoidAccounts` continua vencendo `preferredProfileId`).
   - Adicionado o contrato específico `GrantRequest.examReviewer` (`{ preparedProfiles, avoidExaminerAccounts }`) usado apenas por `reserveSpecialistExamSeat(..., { purpose: 'reviewer' })`.
   - `VerifyWorkerCall` (`src/verify-types.ts`), `reviewFinding` (`src/verify-remediate.ts`) e `reservePersonalRecheckReviewer` (`src/verify-native-launch.ts`) separam `avoidExaminerAccounts` (conta do examinador original, abaixo de revisores preparados) de `avoidAccounts` / `avoidReviewerAccountIds` (conta do 1º revisor em achado `alta`, que mantém preferência por outra conta disponível mesmo sobre revisor preparado na mesma conta, recorrendo à mesma conta em sessão distinta apenas quando não há alternativa).

4. **Recusa explícita acima do limite de exclusões sem corte silencioso (`src/exam-provider.ts`, `src/verify-remediate.ts`)**
   - Removidos os cortes `.slice(0, 20)` / `.slice(0, 8)` em `exam-provider.ts` e `verify-remediate.ts`.
   - `reserveSpecialistExamSeat` aceita integralmente até os limites suportados (`20` em `avoidProfileIds` / `avoidAccountIds` / `preparedProfiles`, `8` em `avoidReviewerAccountIds`) e recusa explicitamente com `Refusal('EXAM_EXCLUSION_LIMIT', 400)` antes de chamar `reserveWithSeat` quando a lista excede o limite.

## Verificações executadas

- `npx tsc --noEmit --skipLibCheck`: passou com código de saída `0`.
- Testes direcionados em PostgreSQL sintético isolado (`postgres:16-alpine` em contêiner temporário `ac-final-a1-r14-pg` na porta `127.0.0.1:54399`, separado do banco da suíte):
  `AC_TEST_DATABASE_URL="postgresql://postgres:synthetic-r14@127.0.0.1:54399/ac_implementation_test" node --import tsx --test --test-concurrency=1 tests/exam-provider.test.ts tests/personal-reserve.test.ts tests/verify-api.test.ts tests/personal-verify-cli.test.ts tests/verify-native-launch.test.ts tests/verify-remediate.test.ts tests/verify-runtime.test.ts tests/exam-context-isolation.test.ts tests/capacity.test.ts tests/capacity-liveness.test.ts tests/capacity-aging.test.ts tests/capacity-exclusions.test.ts`
  - **74/74 passaram** (0 falhas, 0 ignorados), cobrindo histórico preservado com orientação explícita, fluxo real de achado de ferramenta via `runSecurityVerification` + `reverificar`, falha transitória e persistente de `releaseGrant` sem janela pós-reserva, contrato geral de `preferredProfileId` vs `avoidAccounts`, 2º revisor de achado `alta` preferindo outra conta e sessão distinta sem alternativa, e aceitação de 20 / recusa de 21 exclusões sem corte silencioso.
