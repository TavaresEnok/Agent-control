# Relatório Final A.3 — Reconciliação e Aposentadoria de Exame Interrompido

## Causa raiz identificada

Na observação somente leitura do caso A.3 (`ac_native_execution_jobs` com `state = 'uncertain'`, `role = 'specialist'`, sem `network_id`, `tools_id` nem `worker_id`, `ac_capacity_grants` com `state = 'released'`, intenção vinculada a `principal = 'app'`), ocorriam três falhas encadeadas:

1. **Divergência de escopo entre co-proprietários (`NATIVE_EXECUTION_SCOPE_MISMATCH`)**:
   - Os comandos de exame pessoal (`src/design-command.ts` / `src/verify-command.ts`) registram o intent com `principal = project.owner` (ex.: `'app'`).
   - O gateway pessoal (`src/personal-connect.ts`, `src/server-main.ts`, `src/manager-transport.ts`) adiciona a conta Happier como co-proprietária (`'owner'`) em `ac_memberships` e executa `CezarRuntime.reconcileCancellations(authority, principal)` com o principal do gateway.
   - `NativeExecutionSupervisor` (`scope`, `registeredInput`, `recover`) rejeitava `intent.principal_id !== principal` mesmo para co-proprietários `'owner'` do projeto em fase de reconciliação/recuperação, e nem todos os pontos garantiam `i.context_id = j.context_id`.
2. **Job pré-lançamento preso em `'uncertain'` com grant já `'released'`**:
   - Em falha antes da criação dos containers/rede (`releaseBeforeLaunch`), o grant ia para `'released'` e `p.root` (`request.json`) podia ser removido, enquanto `ac_native_execution_jobs` permanecia `'uncertain'` sem IDs físicos (`worker_id`, `tools_id`, `network_id`, `launch_digest`).
   - Como o trigger `ac_guard_capacity_grant_state` (`db/migrations/094_grant_state_machine.sql`) proíbe alterar um grant já `'released'` (`GRANT_ALREADY_RELEASED`), e os caminhos de `reconcile`, `reconcileRegistered`, `recover`, `reconcileCancellation` e `retireTerminal` exigiam `request.json` ou IDs físicos de 64 caracteres hexadecimais, o job nunca recebia recibo terminal assinado nem aposentadoria em `ac_native_terminal_retirements`.
3. **Omissão na seleção e manutenção de exames `specialist` / somente leitura**:
   - `CezarRuntime.reconcileCancellations` (`src/cezar.ts`) selecionava `j.id` sem filtrar `i.context_id = j.context_id` / `NOT cx.archived`, omitia `role = 'specialist'` (e `reviewer` de exame pessoal finalizado) da aposentadoria terminal em `ac_native_terminal_retirements`, e tentava chamar `verifier.record` em `reviewer` de workflows `design-readonly-v1` / `security-verify-readonly-v1`.
   - `OPEN_EXECUTION_JOBS_SQL` (`src/personal-maintenance.ts`) não contabilizava `role = 'specialist'` ao verificar jobs abertos ou sem aposentadoria terminal.
   - `reconcileNativeResourceAdmissions` (`src/native-resource-envelope.ts`) ignorava admissões de jobs `'uncertain'` pré-lançamento com grant `'released'`, não validava `g.context_id = r.context_id AND i.context_id = r.context_id` nem co-proprietários `'owner'`, e retornava cedo em waits do mesmo epoch mesmo quando `g.state = 'released'` (além de poder limpar visitas ativas de outro principal se um operador chamasse a reconciliação).

## Mudanças no produto

- **`src/sandbox-broker.ts`**: adicionado `DockerDaemon.inspectNamedPrivateNetwork(name)` validando `^ac-native-exec-<uuid>$` e consultando `/v1.44/networks/${name}` no socket Docker para comprovar ausência física da rede pelo nome quando `network_id IS NULL`.
- **`src/native-execution-supervisor.ts`**:
  - Adicionado `assertIntentScope` reforçando `i.context_id = authority.contextId`; `allowCoOwner` é habilitado apenas em caminhos de reconciliação/aposentadoria/recuperação quando ambos os principais são `'owner'` em `ac_memberships` do projeto (nunca em `start()` de novos jobs nem para `'operator'`).
  - `releaseBeforeLaunch` agora também transiciona `ac_native_execution_jobs` para `'failed'` com recibo assinado `unstartedReceipt` (`executionStarted: false`) vinculado a `physicalDigest` do grant (e `ac_operations` quando `'programmer'`).
  - Adicionados `isUnstartedTerminalRow`, `verifyTerminalReceipt`, `confirmUnstartedAbsence`, `settleUnstartedReleasedJob` e `reconcileUnstarted`: após comprovar ausência de `launch.json`/`launch.pending*`, ausência dos containers `ac-native-worker-<jobId>` e `ac-native-tools-<jobId>` e ausência da rede privada `ac-native-exec-<jobId>` (ou remoção segura de rede órfã sem containers cujo rótulo corresponda ao job), o job `'uncertain'` com grant `'released'` é fechado como `'failed'` com recibo Ed25519 sem reexecução e sem reescrever o grant já `'released'`.
  - `retireTerminal` aceita ausência de `request.json` (`ENOENT`) e emite `binding` + prova Ed25519 (`kind: 'native-unstarted-retired'`, `executionStarted: false`) em `ac_native_terminal_retirements` (`state = 'removed'`), mantendo exames pessoais `specialist`/`reviewer` sem exigir registro indevido em `ac_verification_evidence`.
- **`src/cezar.ts`**: `reconcileCancellations` agora exige `i.context_id = j.context_id` e `NOT cx.archived`, evita `verifier.record` para workflows de exame somente leitura (`design-readonly-v1`, `security-verify-readonly-v1`), e inclui `specialist` (e `reviewer` somente leitura finalizado) na seleção e verificação de aposentadoria terminal.
- **`src/native-resource-envelope.ts`**: `reconcileNativeResourceAdmissions` agora exige `g.context_id = r.context_id AND i.context_id = r.context_id`, dá suporte a co-proprietários `'owner'` sem permitir que um não-proprietário apague visitas ativas em `ReconciliationHistory`, e não trata `grant_state = 'released'` do mesmo epoch como wait saudável em andamento.
- **`src/personal-maintenance.ts`**: `OPEN_EXECUTION_JOBS_SQL` passa a incluir `'specialist'` junto aos papéis avaliadores que exigem `ac_native_terminal_retirements(state = 'removed')`.

## Comandos já existentes e prova sintética

- O próprio fluxo contínuo do gateway (`npm run gateway -- <instalação.json>`, via `startConfiguredManagerTransport` -> `HappierEndpoint` -> `CezarRuntime.reconcileCancellations` em `src/server-main.ts`) e a manutenção periódica (`npm run personal:maintenance -- <instalação.json>` em `src/personal-maintenance.ts`) já executam a reconciliação e verificam a liberação das imagens aposentadas sem exigir um novo comando exclusivo.
- A prova em instalação sintética isolada foi implementada em `tests/native-interrupted-exam-recovery.test.ts`:
  - Reproduz um contexto `design` em modo `'personal'` com intenção criada por `'app'`, gateway co-proprietário `'owner'`, jobs `'specialist'` em `'uncertain'` sem IDs físicos e grants `'released'` (com e sem `request.json`), além de uma admissão pendente em `ac_native_resource_admissions`.
  - Verifica contraprovas de isolamento (`operator` no mesmo projeto, `owner` estrangeiro, autoridade de outro contexto, referência cross-context forjada, `start()` por co-proprietário e rede física residual impedindo fechamento/aposentadoria).
  - Prova que `reconcileNativeResourceAdmissions`, `supervisor.recover`, `CezarRuntime.reconcileCancellations` e `runPersonalMaintenance` contra `installation.json` sintético e banco PostgreSQL isolado fecham todos os jobs como `'failed'` (`executionStarted: false`, zero criações/inícios de container), gravam `ac_native_terminal_retirements(state = 'removed')` assinado, permanecem idempotentes na segunda passagem e zeram `OPEN_EXECUTION_JOBS_SQL`, permitindo que `personal:maintenance` remova `retiredImages`.

## Verificações executadas

- Typecheck: `npx tsc --noEmit --skipLibCheck` -> **passou (exit code 0)**.
- Testes direcionados em PostgreSQL efêmero descartável (`deploy/compose.round2-test.yml`, `postgres:16-alpine`, encerrado após a execução):
  - `node --import tsx --test tests/native-interrupted-exam-recovery.test.ts tests/native-execution-supervisor.test.ts tests/r4-native-resource-routing.test.ts tests/native-terminal-retirement.test.ts tests/r2-graph-cancellations.test.ts tests/personal-maintenance.test.ts` -> **14 testes, 14 passaram, 0 falharam, 0 pulados**.
