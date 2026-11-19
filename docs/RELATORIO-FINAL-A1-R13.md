# Relatório — Rodada 13 (revisão dos assentos)

Executado conforme [ORDEM-FINAL-A1-R13.md](docs/ORDEM-FINAL-A1-R13.md) no worktree `/home/app/projects/ac-wt/final-a1-r13` (ramo `task/final-a1-r13`).

## Correções implementadas

1. **Exclusão do examinador vinculada ao achado original na reverificação (`db/migrations/103_verify_finding_examiner.sql`, `src/verify-runtime.ts`, `src/verify-types.ts`, `src/verify-remediate.ts`, `src/verify-native-launch.ts`, `src/server-main.ts`)**
   - Criada a migração `103_verify_finding_examiner.sql` adicionando `examiner_profile_id uuid` e `examiner_account_id uuid` (anuláveis, sem backfill artificial) em `ac_verify_findings`.
   - `runSecurityVerification` (`src/verify-runtime.ts`) persiste `examiner_profile_id` e `examiner_account_id` do examinador em cada achado produzido por modelo e mantém `NULL` para achados brutos de ferramentas.
   - `recheckFindings` (`src/verify-remediate.ts`) lê com segurança (`optionalUuid`) `examiner_profile_id` e `examiner_account_id` do achado original e repassa `avoidProfiles`/`avoidAccounts` em `VerifyWorkerCall` (`src/verify-types.ts`) tanto na primeira quanto na segunda revisão (achados `alta`), sem inventar identidade quando nulos (dados históricos ou achados de ferramenta).
   - `createRecheckNativeWorker` e `reservePersonalRecheckReviewer` (`src/verify-native-launch.ts`) e `personalVerification.recheck` (`src/server-main.ts`) reservam o revisor via `reserveSpecialistExamSeat(..., {purpose: 'reviewer', avoidProfileIds, avoidAccountIds})`, recusando com `DESIGN_REVIEWER_UNAVAILABLE` (409) inclusive quando existe apenas um perfil Claude em `specialist` e ele foi o examinador do achado.

2. **Prioridade do perfil revisor preparado sobre `avoidAccounts` mantendo fallback legítimo (`src/exam-provider.ts`, `src/capacity.ts`)**
   - `loadSpecialistExamPlan` (`src/exam-provider.ts`) passa a carregar `accountByProfileId`; no propósito `'reviewer'`, `reserveSpecialistExamSeat` ordena `plan.reviewerProfileIds` não excluídos priorizando os que estão fora de `avoidAccounts` e preservando os demais revisores preparados em `preferredProfileId`/`preferredProfiles`.
   - `Capacity.reserve` (`src/capacity.ts`) aceita `preferredProfiles` em `GrantRequest` e prioriza perfis elegíveis do conjunto preferido (dando preferência interna a contas fora de `avoidAccounts`) antes de recorrer a perfis não preferidos da cadeia (`regular`), mantendo a preferência por outra conta quando nenhum perfil preparado elegível estiver disponível.

3. **Exclusão de todos os perfis examinadores da tela no exame de design (`src/design-examine.ts`, `src/design-command.ts`)**
   - Em `examineDesignScreens` (`src/design-examine.ts`), quando `scoreVisual === true`, o exame visual do especialista (`askVisual(..., 'specialist')`) é executado antes das revisões daquela tela para reunir todos os perfis (`seat.profileId` e `examinerVisual.seat.profileId`) e contas que examinaram a tela na execução.
   - `DesignReserveOptions` e `resolvePersonalDesign` (`src/design-command.ts`) aceitam e propagam `avoidProfileIds` e `avoidAccountIds` para todas as etapas de revisão da tela (confirmação de achados de código, crítica visual do revisor e confirmação de achados visuais).

4. **Liberação garantida de grants após `reserve` em falhas de leitura ou validação (`src/exam-provider.ts`)**
   - Extraído `acceptReservedSeat` em `src/exam-provider.ts` para o fluxo de `reviewer`, `create` e `examiner`: qualquer exceção entre `capacity.reserve` e a entrega do assento ao chamador (erro de consulta, `GRANT_FORBIDDEN`, `EXAM_PROVIDER_UNSUPPORTED` ou provedor não-Claude no revisor) aciona `releaseGrant(grant.id)` preservando o erro original.

## Regressões adicionadas e verificações

- Regressões adicionadas com bancos sintéticos isolados (`isolatedDatabase`):
  - `tests/exam-context-isolation.test.ts`: fluxo normal da API (`POST /api/v1/ac/personal/verificacoes/:runId/reverificar` via `createApi`) recusando perfil único com `409 DESIGN_REVIEWER_UNAVAILABLE`, mantendo dados históricos sem inventar identidade, vinculando exclusão por achado e validando persistência de `examiner_profile_id`/`examiner_account_id`; e recusa `DESIGN_REVIEWER_UNAVAILABLE` quando código e visual usaram os dois únicos perfis disponíveis.
  - `tests/personal-reserve.test.ts`: prioridade do perfil revisor preparado sobre outra conta (`regular`), escolha de revisor preparado em outra conta quando há dois, fallback para o revisor preparado na mesma conta, fallback legítimo para outra conta quando nenhum revisor preparado é elegível, e liberação de grant em falhas entre `reserve` e leitura/validação em `reserveSpecialistExamSeat`.
  - `tests/design-examine.test.ts`: exclusão de ambos os perfis/contas (código e visual) nas três chamadas de revisão da tela.
- `npx tsc --noEmit --skipLibCheck`: passou com código de saída `0` (com `upstream/cezar/packages/cezar/dist` copiado para o diretório ignorado pelo git no worktree para resolução de tipos/módulos locais).
- `AC_TEST_DATABASE_URL="$(cat /tmp/ac-vordem5-base-url)" node --import tsx --test --test-concurrency=1 tests/personal-reserve.test.ts tests/design-examine.test.ts tests/exam-provider.test.ts tests/verify-native-launch.test.ts tests/verify-api.test.ts tests/verify-remediate.test.ts tests/verify-runtime.test.ts tests/exam-context-isolation.test.ts`: **59/59 passaram** (0 falhas, 0 ignorados).
