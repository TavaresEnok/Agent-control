# Continuação: dispensa de QA e contenção de worktree — 04/11/2026

Base `2c58dc29`, branch `continuation/cursor-20261104`. Esta fatia não aceita RF-54, RF-57, T34 ou T38 e requer revisão independente posterior. A equipe atualmente autorizada contém somente o agente principal.

## Posse e recuperação

`claimWorktreeWriter` mantém a cópia vinculada à primeira intenção e época; nem uma linha legada `neutralized` permite outra posse. Uma nova intenção precisa de outro `runId` e outra cópia. `neutralizeWorktreeWriter` recusa com `WORKTREE_TERMINAL_PROOF_REQUIRED` mesmo ao titular: uma transição no banco não prova que acesso de escrita foi revogado. Isso é uma contenção que pode impedir recuperação; não termina processos, revoga mounts ou garante isolamento entre cópias. O grafo e o supervisor ainda precisam de um protocolo físico durável, com observação terminal, revogação, recibo e fencing antes de qualquer liberação. A migração 062 reserva metadados; os valores não são prova física. Sua constraint não aceita novos `neutralized` com digest nulo; `NOT VALID` preserva linhas históricas sem tratá-las como prova. O rascunho encontrado antes da edição está em `validation/evidence/worktree-writer-proof-draft-20261104.sql.txt`.

## Autorização do titular no painel

A leitura autorizada de recursos identifica o template de catálogo ativo e a revisão e os digests correspondentes, somente se os snapshots e a política de qualidade conferirem e a política permitir a dispensa. O titular informa o identificador da tarefa e assina `qa.waiver.authorize` pela rota e identidade existentes. O formulário informa que o alcance é o projeto inteiro, inclusive outras conversas com o mesmo template e tarefa, e lista autorizações conhecidas; uma lista truncada bloqueia o envio no painel. O backend continua a autoridade. A autorização é anterior à avaliação de cada artefato, não uma aprovação de QA ou revisão; não há revogação implementada.

## Evidências

Laboratório separado iniciado exclusivamente com `docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml up -d db runtime`. O PostgreSQL da bancada anterior não foi usado. Node no runtime: 22.23.3; Ruby: 3.4.12. O Node do host era 24.22.1. Sem conta real, inferência paga, SSH operacional ou Docker socket em worker.

- `docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml exec -T runtime node --import tsx --test --test-concurrency=1 --test-name-pattern='QA authorization' tests/native-multitask.test.ts`: exit 0, cinco variantes, sem skips (`continuation-qa-graph-cases-20261104.log`). Com PostgreSQL, Cezar, grafo, worktree Git, finalizador e integração reais em bancada, executores de modelo/QA/revisão sintéticos. Autorização válida cria `not_required`, sem grant nem evidência QA; as variantes desabilitada, ausente, template divergente e ambígua executam QA. A revisão e integração exata continuam presentes.
- A variante válida também foi executada com pausa persistente, fechamento e novo runtime após conclusão, seguida de observação repetida: exit 0 (`continuation-qa-graph-restart-20261104.log`). Não prova reinício no meio de um efeito.
- `tests/qa-waiver-stage.test.ts` e `tests/worktree-lease.test.ts`, no mesmo compose: controle assinado, idempotência, recusa de viewer, projeção owner/viewer e contenção, exit 0 (`continuation-qa-control-corrected-20261104.log`; nova prova do escritor vivo em `continuation-lease-live-writer-20261104.log`). Falha anterior exit 1 está preservada em `continuation-qa-control-20261104.log`: o teste esperava `PROJECT_OWNER_REQUIRED`, mas a checagem central recusou primeiro com `CONTEXT_FORBIDDEN`; não foi alterada a recusa do produto.
- `npm --prefix upstream/cezar test -- packages/web/src/routes/settings/agent-control-project-templates.test.tsx`: exit 0, seis testes (`continuation-qa-panel-20261104.log`). `npm run typecheck` e `npm --prefix upstream/cezar run typecheck:web`: exit 0 no host. Não houve browser real ou dispositivo físico.
- `continuation-qa-graph-20261104.log` preserva a primeira execução positiva da variante válida. `continuation-qa-view-lease-20261104.log` e `continuation-lease-check-20261104.log` preservam as verificações anteriores.

O resultado de QA cancelado, falho, ausente ou obsoleto e a mudança de artefato têm prova de componente PostgreSQL prévia e desta bancada, mas ainda não prova de todos esses casos no grafo. A cópia anterior de um escritor ativo não foi fisicamente isolada por esta fatia. Revisão humana/independente, cancelamento durante etapa, revogação de autorização e recuperação física permanecem pendentes.

## Prova adicional de concorrência Git (T10)

`docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/git-cas-concurrency.test.ts` saiu 0 (`continuation-git-cas-race-20261104.log`). Em repositório Git descartável real, dois candidatos com a mesma base disputaram a referência e exatamente um CAS integrou. Uma mudança externa da referência fez um candidato obsoleto receber `BASE_MOVED`. Dependendo do intervalo, o perdedor concorrente também pode receber erro do helper e ficar incerto; isso não é integração. O teste não usa dois chats, não rebaseia nem refaz evidências, e T10 continua sem aceite. A matriz passa de 93/18 para 94 parciais/17 não implementados por esta evidência parcial.

O primeiro typecheck após acrescentar o teste de CAS saiu 1 (`continuation-typecheck-20261104.log`): a asserção do próprio teste não estreitava o union TypeScript. A asserção foi corrigida sem alterar o produto; a repetição e o teste de CAS estão em logs separados com sufixo `corrected`.
