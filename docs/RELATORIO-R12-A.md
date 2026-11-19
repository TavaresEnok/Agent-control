# Relatório — reconstrução do design, rodada 12 (trabalhador A)

Executado conforme [ORDEM-DESIGN-RECONSTRUCAO-12.md](docs/ORDEM-DESIGN-RECONSTRUCAO-12.md) no worktree `/home/app/projects/agent-control-design-b` (ramo `task/design-r5-b`).

## Resumo das alterações

1. **Reserva de perfil específico / exclusão do examinador em `Capacity.reserve` (`src/capacity.ts`)**
   - `GrantRequest` passa a aceitar os parâmetros opcionais `preferredProfileId`, `avoidProfiles` e `provider`.
   - `preferredProfileId` prioriza o perfil indicado dentro da cadeia do papel; `avoidProfiles` exclui estritamente o perfil já usado pelo examinador (sem fallback para ele); `provider` restringe a seleção a contas daquele provedor.
   - A evidência `selection` mantém compatibilidade com `projectCapacitySelection` (`src/control.ts`) e não sobrescreve `ac_regular_selections` quando a reserva usa `preferredProfileId` ou `avoidProfiles`.

2. **Exame de design e `criar` sempre no papel `specialist` (`src/exam-provider.ts`, `src/design-command.ts`, `src/design-examine.ts`, `src/design-module.ts`, `src/personal-design-cli.ts`)**
   - `src/exam-provider.ts` adiciona `loadSpecialistExamPlan` e `reserveSpecialistExamSeat`: lê `roles.specialist` da política ativa do contexto, prefere o perfil `claude-opus-5-5` para `create`, o perfil não-Opus regular para `examiner` e o perfil de `emergency` preparado pelo `preparar` para `reviewer` (excluindo estritamente o `profileId` do examinador e evitando suavemente sua conta quando houver outra conta Claude).
   - `src/design-command.ts` (`resolvePersonalDesign`) reserva **sempre `role: 'specialist'`** — nunca `role: 'reviewer'` — e devolve `grantRole: 'specialist'` no assento; `src/design-examine.ts` propaga `avoidProfileId`/`avoidAccountId` do examinador para `confirmFinding` e `askVisual` (usando `seat.grantRole ?? role` no `DesignWorkerCall`) e repropaga `DESIGN_REVIEWER_UNAVAILABLE` em `rethrowReviewer`.
   - `src/personal-design-cli.ts` envia `{purpose: 'create'}` na reserva do `runDesignCreate`.

3. **Mesmo padrão no exame do validador (`src/verify-runtime.ts`, `src/server-main.ts`, `src/verify-native-launch.ts`, `src/personal-verify-cli.ts`)**
   - `src/verify-runtime.ts` (`runSecurityVerification` / `reserveAndRun`) passa a reservar **sempre `role: 'specialist'`** via `reserveSpecialistExamSeat` tanto para mapa/exame (`examiner`) quanto para confirmação (`reviewer`), excluindo estritamente `examinerProfileId ?? mapProfileId` e evitando suavemente `examinerAccountId ?? mapAccountId`, e enviando `role: 'specialist'` no `VerifyWorkerCall`.
   - `src/server-main.ts` (`personalVerification.recheck`) e `src/verify-native-launch.ts` (`createRecheckNativeWorker`) também reservam `role: 'specialist'` (`provider: 'claude'`) em vez do papel `reviewer` do projeto, mantendo compatibilidade com testes de `createRecheckNativeWorker` via `reserved.role ?? 'reviewer'`.

4. **Recusa clara `DESIGN_REVIEWER_UNAVAILABLE` (`src/exam-provider.ts`, `src/personal-design-cli.ts`, `src/personal-verify-cli.ts`)**
   - Quando a cadeia `specialist` não tem um segundo perfil Claude disponível (`NO_ELIGIBLE_CAPACITY`, `ROLE_NOT_CONFIGURED` ou assento não-Claude no revisor), `reserveSpecialistExamSeat` recusa com `Refusal('DESIGN_REVIEWER_UNAVAILABLE', 409)` em vez de `EXAM_PROVIDER_UNSUPPORTED`.
   - `src/personal-design-cli.ts` e `src/personal-verify-cli.ts` mapeiam `DESIGN_REVIEWER_UNAVAILABLE` para a mensagem: `Falta um segundo perfil Claude na cadeia specialist para o revisor; rode \`npm run personal:design -- preparar <instalação.json> <projectId> --aplicar\`.`.

5. **Testes (`tests/exam-context-isolation.test.ts`, `tests/verify-runtime.test.ts`, `tests/verify-ruler.test.ts`, `tests/verify-exam-worker-mount.test.ts`, `tests/personal-reserve.test.ts`, `tests/personal-design-cli-message.test.ts`, `tests/personal-verify-cli.test.ts`)**
   - Adicionados testes com banco de teste cobrindo: projeto com cadeia `reviewer` Codex e 3 perfis Claude em `specialist` (examinador e revisor recebem perfis Claude distintos de `specialist`; zero grants com `role='reviewer'`) no design/`criar` e no validador; recusa com `DESIGN_REVIEWER_UNAVAILABLE` quando há apenas 1 perfil Claude em `specialist` (ou 1 Claude + 1 Grok); `preferredProfileId`, `avoidProfiles` e `provider` em `Capacity.reserve`; e mensagens de erro da CLI.
   - Atualizados `tests/verify-runtime.test.ts`, `tests/verify-ruler.test.ts` e `tests/verify-exam-worker-mount.test.ts` para refletir o uso de `specialist` na confirmação sem criar grants de `reviewer`.

## Verificações executadas

- `npx tsc --noEmit --skipLibCheck`: passou (código de saída `0`).
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test --test-concurrency=1 tests/capacity.test.ts tests/personal-reserve.test.ts tests/exam-provider.test.ts tests/design-examine.test.ts tests/design-module.test.ts tests/design-prepare.test.ts tests/personal-design-cli.test.ts tests/personal-design-cli-message.test.ts tests/personal-verify-cli.test.ts tests/verify-native-launch.test.ts tests/verify-command.test.ts tests/verify-ruler.test.ts tests/verify-runtime.test.ts tests/exam-context-isolation.test.ts`: 97/97 passaram.
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test --test-concurrency=1 tests/verify-exam-worker-mount.test.ts tests/design-native-launch.test.ts tests/design-capture-stage.test.ts tests/exam-strip-note.test.ts`: 26/26 passaram.
- `AC_TEST_DATABASE_URL=postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test node --import tsx --test --test-concurrency=1 tests/r3-provider-chain.test.ts tests/r3-model-quota-scopes.test.ts tests/capacity-aging.test.ts tests/capacity-wait-resources.test.ts tests/capacity-prelaunch-refusals.test.ts`: 13/13 passaram.
