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
