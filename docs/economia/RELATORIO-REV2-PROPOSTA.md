# Relatório REV2 - proposta durável (achado 8)

Ramo `task/econ2-proposta`, base `73c524b2`. Migração usada: 118.

## Confirmação dos achados

Os dois se confirmam no código da base.

- (a) `processSemanticProposal` gravava a intenção como `done`, a saída como `dispatched` e a mensagem da proposta numa transação. Só depois lia `auto_approve_plans` e chamava `startProposal`. Uma queda entre as duas etapas deixava a proposta publicada, sem execução, e `tick()` não revisita intenção `done`.
- (b) `resolveLatestProposal` consultava "já decidida" (intenção `plan.start` ou auditoria `proposal.discarded`) e agia em outro passo. `startProposal` usava `randomUUID()`. O banco só protegia `ac_intents` pela chave do ID e a execução filha por `parent_intent_id` (`ac_managed_executions`): duas aprovações, ou aprovar e descartar, podiam passar juntas e criar duas execuções do mesmo par (contexto, revisão). Isso vale também para quem inicia pela API (`/api/v1/ac/commands`, ID aleatório).

## O que mudou

- `db/migrations/118_proposal_decisions.sql`
  - Tabela `ac_proposal_decisions` com chave primária (contexto, revisão) e o digest da proposta. Colunas: `decision` (`approved` ou `discarded`), `source` (`manual`, `auto`, `api`, `legacy`) e `intent_id` (obrigatório se aprovada). Imutável (gatilho barra UPDATE e DELETE).
  - Preenche decisões antigas: `plan.start` gerenciado existente vira `approved/legacy` (uma por revisão, mesmo com duplicatas), `proposal.discarded` da auditoria vira `discarded/legacy`. Verificado com dados antigos duplicados.
  - Gatilho `BEFORE INSERT` em `ac_intents`: todo `plan.start` gerenciado de topo registra ou confere a decisão. Segunda intenção da mesma revisão, ou início depois de descarte, falha com `PROPOSAL_ALREADY_DECIDED`. Digest diferente falha com `PROPOSAL_DIGEST_CONFLICT`. Isso protege também API e painel, não só o gerente pessoal.
- `src/proposal-decision.ts` (novo)
  - `proposalStartIntentId` dá o ID estável da execução (contexto + revisão).
  - `decideProposal` grava a decisão com `INSERT ... ON CONFLICT DO NOTHING`. O primeiro vence. Os outros leem a decisão existente, e a repetição devolve a mesma.
  - `unstartedProposals` lista aprovações sem execução.
- `src/happier.ts`
  - Na mesma transação da publicação da proposta, se o projeto tem autoaprovação, grava a decisão `approved/auto` com o ID estável.
  - `startDecidedProposal` cria a execução com esse ID, se ainda não existe. Um `INTENT_PAYLOAD_CONFLICT` com a execução já existente é tratado como sucesso.
  - `recoverProposalStarts` roda em `tick()` (modo pessoal) e depois da publicação. Cria a execução de toda aprovação sem execução: queda após o commit, resposta perdida, contexto pausado na hora. Aprovações manuais recuperadas reenviam a mensagem "A execução começou" (mesmo `localId`).
  - `resolveLatestProposal` grava a decisão numa transação (autorização e fence) e só depois age. Repetição devolve "já foi decidida" e, se a aprovação existente não tem execução, conclui a execução.
  - `startProposal` (ID aleatório) foi removido.
- Fora dos arquivos da ordem: `tests/local-compositor-capacity.test.ts`. O teste criava duas execuções da mesma proposta no mesmo contexto, o que o gatilho agora barra. Ele passa a publicar uma segunda proposta para a segunda execução. Nada mais mudou nele.
- `quality.ts` e `ledger.ts` não foram tocados. A aprovação de integração Git está intacta.

## Testes (`tests/proposal-decision.test.ts`, banco real)

1. Aprovar/aprovar e aprovar/descartar em paralelo dão uma decisão e um ID de execução. A repetição, mesmo com a palavra oposta, devolve a decisão guardada. Digest diferente é recusado. A decisão é imutável. Duas intenções para a mesma revisão: uma passa e a outra falha. Início depois de descarte falha. Intenção iniciada só pelo ledger (API) registra a própria decisão e barra um descarte posterior.
2. Autoaprovação com queda logo após o commit da publicação. O primeiro processo morre ao pedir a execução. Há proposta publicada, intenção `done`, decisão `approved/auto` e zero execuções. O novo processo faz 3 ticks e cria exatamente uma execução, com o ID estável e o digest da proposta. "aprovar" e "descartar" depois não criam segunda execução nem desfazem a aprovação.
3. Aprovações manuais: aprovar/aprovar em paralelo dá uma execução. Aprovar/descartar em paralelo dá uma decisão e uma execução coerente com ela. A resposta perdida na revisão 3 (queda após a decisão) é concluída por uma repetição, com exatamente uma execução.

Antes da correção (código da base com o novo teste):
- Teste 2 falha de forma determinística: `0 !== 1`, nenhuma execução depois do reinício.
- Teste 3 falha, e a corrida não é determinística: o código antigo não grava decisão e usa ID aleatório.
- Teste 1 só tem sentido com a migração. No esquema antigo nada impede duas intenções `plan.start` da mesma revisão, como mostra o teste `local-compositor-capacity` que as criava.

Depois: os 3 testes passam, rodados 3 vezes em seguida. `npx tsc --noEmit` sem erros.

Testes existentes que passam com a mudança, usando o banco `ac_t_proposta` (o helper de banco isolado foi ajustado só localmente e revertido):
- `semantic-conversation`, `local-transport`, `managed-core-negative`, `managed-recovery`, `managed-recovery-negative`, `manager-lifecycle`, `notifications`, `workflow-generations`, `quality-gate-integrity`.
- `managed-corrections`, `managed-specialist`, `managed-runtime-integration`, `happier-access-boundary`.
- `ledger` (RF-* e checkpoint), `capacity-wait-resources`, `native-dispatch`, `native-multitask`, `native-corrections`, `native-graph-unstarted-recovery`.
- `native-correction-order`, `native-job-work-retention`, `local-compositor-capacity` (depois do ajuste).

## Limites

- A execução nos testes é a linha de `ac_intents` (mesma inserção do ledger), não o `ledger.accept` nativo completo. A fixture nativa completa exige Docker e executor reais. A idempotência do `accept` real por ID vem do bloqueio advisory já existente, mais o gatilho.
- Não rodaram, por falta de ambiente (banco `/ac_implementation_test` exigido, Docker ou executor real, `web/dist`): `happier.test` C02, `native-pause`, `r3-conversation-flow`, `r4-native-qa-correction`, `runtime.test` e as físicas `r2/r5`. Teste do mesmo tipo fora da lista pode, em tese, criar duas execuções da mesma revisão e falhar com `PROPOSAL_ALREADY_DECIDED`. Eu só achei `local-compositor-capacity`.
- Uma aprovação cuja execução falha de forma permanente (por exemplo `MANAGED_PROPOSAL_MISMATCH`) é tentada a cada tick e aparece como falha de recuperação (a notificação de bloqueio é deduplicada). Não há estado "falhou ao iniciar", mas ela já não trava as outras (ver Correção da revisão).
- O gatilho ignora `plan.start` sem revisão e digest bem formados. O contrato de comando já os rejeita antes do banco.
- A decisão vale por revisão. A proposta decidida continua sendo a mais recente publicada (comportamento anterior de `aprovar` e `descartar`).

## Correção da revisão independente

- MEDIUM, `recoverProposalStarts` parava no primeiro erro: uma aprovação sempre recusada (`MANAGED_PROPOSAL_MISMATCH`, `NATIVE_TASK_BASE_MISSING`, `NATIVE_PLAN_TEMPLATE_REQUIRED`) ficava na frente da fila e bloqueava as posteriores, inclusive as autoaprovações novas. Agora o laço tenta cada aprovação dentro de um `try/catch` e relança só a primeira falha no fim, de modo que `tick()` continua vendo o erro e repete no tick seguinte. A chamada logo depois da publicação em `processSemanticProposal` passou a tratar só a revisão recém-publicada (`recoverProposalStarts(result.revision)`), então uma aprovação antiga recusada não faz a publicação falhar. As antigas continuam sendo recuperadas por `tick()`. Arquivo: `src/happier.ts`.
- Teste: `an approval that is always refused does not hold back the approvals after it` em `tests/proposal-decision.test.ts` (banco real). Recusa as revisões 1 e 2 (autoaprovadas): nenhuma execução. Depois só a 1 segue recusada: `tick()` falha por causa da 1 mas cria a execução da 2. Uma terceira proposta, publicada com a 1 ainda recusada, inicia na hora e a intenção de planejamento termina `done`. Antes da correção: falha com `0 !== 1` (nenhuma execução da revisão 2). Depois: passa. Os 4 testes do arquivo passam.
- LOW, `tests/local-compositor-capacity.test.ts` fora da lista: mantido. A mudança é necessária (o gatilho barra duas execuções da mesma revisão, comportamento pedido pela ordem) e é a única forma de o teste continuar exercitando duas execuções. Não há outra mudança barata.
- Verificação ampliada, com o helper de banco isolado relaxado só localmente e revertido: `local-compositor-capacity`, `semantic-conversation`, `manager-lifecycle`, `managed-core-negative`, `native-multitask`, `native-graph-unstarted-recovery`, `local-transport` e `notifications` passam. `native-dispatch` falha com `ISOLATED_NATIVE_CONTROLLER_REQUIRED`, igual sem as mudanças (ambiental). `npx tsc --noEmit` sem erros.
