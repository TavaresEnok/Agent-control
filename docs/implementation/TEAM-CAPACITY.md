# Capacidade: fila e troca de gerente — 05/11/2026

Duas correções sintéticas, sujeitas a revisão independente e sem aceite de requisitos:

- Uma repetição de reserva de modelo com a mesma tentativa agora exige `GRANT_RECONCILIATION_REQUIRED` quando a concessão pertence a época anterior, como já ocorria no compositor. A concessão antiga permanece reservada; a mudança não a reconcilia nem prova que um processo parou.
- O primeiro candidato da fila por conta precisa continuar com conta sintética habilitada e elegível, quota disponível e fresca, acesso do projeto, contexto ativo e intenção sem cancelamento próprio ou do plano pai. Uma espera que perdeu acesso deixa de impedir uma reserva elegível de outro projeto. A espera não é apagada automaticamente e poderá ser reavaliada pelo próprio chamador.

## Verificação

Em worktree isolada e PostgreSQL descartável com bancos de fixture distintos, sem provedores reais:

- `AC_TEST_DATABASE_URL=... node --import tsx --test --test-concurrency=1 tests/capacity.test.ts`: exit 0, 9 testes, sem skips. Inclui duas conexões, perda de acesso entre projetos e recusa da tentativa original após troca de época.
- `AC_TEST_DATABASE_URL=... node --import tsx --test --test-concurrency=1 tests/capacity-wait-resources.test.ts tests/capacity-exclusions.test.ts tests/capacity-prelaunch-refusals.test.ts`: exit 0, 14 testes, sem skips.
- `npm run typecheck`: exit 1; quatro erros nas declarações compiladas do Cezar referentes a tipos Zod (`ZodPreprocess` e `ZodInstanceOf`). O checkout usou link local para o `dist` preexistente do Cezar; a primeira execução sem esse artefato falhou com `ERR_MODULE_NOT_FOUND`. Node v24.22.1, fora da faixa Node 22 declarada pelo projeto.

As provas não demonstram justiça completa entre hosts, ciclo físico de processos, provedores ou cotas reais, nem migração com autoridade de reservas única. T01–T04, T11–T12, T20, T28 e T29 permanecem sem aceite; T10 e T16 não são cobertos por esta fatia. Não houve revisão independente nem operação externa.

## Progresso sintético por etapa — continuação

`tests/capacity-liveness.test.ts` executou em PostgreSQL descartável (Node v24.22.1), exit 0, um teste, sem skips. O teto global de programação foi saturado; uma conta compartilhada com limite um recusou QA enquanto o grant programador existia. Após recibos sintéticos `not_started` e liberação explícita de cada etapa, QA, revisão e especialista obtiveram concessões sequenciais. Com programador em outra conta, QA também obteve grant simultaneamente, apesar do teto de programação saturado. Isto verifica a política de capacidade diretamente; não demonstra que o grafo libere etapas automaticamente nem ausência geral de starvation ou espera circular.

A mesma prova verificou que a reserva original recusa novo programador quando outra conta elegível está disponível, admite quando a alternativa fica esgotada e volta a recusar novos grants quando a alternativa recupera. O grant original anterior permanece reservado com as mesmas revisões de política e configuração após recuperação e alteração de configuração. Esse snapshot identifica revisões; não registra todos os fatos de quota que fundamentaram a decisão. As contas, observações e recibos são fixtures, sem inferência sobre provedores ou cotas reais. A primeira execução falhou porque o nome do banco de teste tinha underscore proibido pela fixture; após trocar o nome, a prova passou. T29 permanece parcial e sem aceite e a revisão independente permanece pendente.

## Handoff e revisão de política com estado running

No Node v22.23.3 e PostgreSQL descartável, `AC_TEST_DATABASE_URL=... /tmp/node-v22.23.3-linux-x64/bin/node --import tsx --test --test-name-pattern='running regular' tests/capacity-liveness.test.ts` terminou com exit 0, um teste e nenhum skip. Com o primeiro perfil regular indisponível, o segundo foi selecionado e posto em `running`; após recuperação do primeiro, o segundo permaneceu selecionado para a próxima tentativa e o grant anterior continuou `running`. Com ambos regulares indisponíveis, a reserva emergencial foi posta em `running`; ao recuperar o primeiro regular, a próxima tentativa usou-o enquanto a reserva permaneceu `running`.

Em outra tentativa, uma revisão de política foi publicada e atribuída entre o grant e seu início. As transições `reserved → running → released` mantiveram perfil e revisão originais; uma tentativa posterior usou o novo perfil e revisão. As transições e recibos foram invocados pelo teste, sem processo de trabalho real; `running` é estado persistido, não observação física de saúde. Os ensaios são escopo de serviço sintético para T03, T04 e T12, sem prova de handoff integral, revogação física, provedores ou revisão independente e sem aceite desses cenários.
