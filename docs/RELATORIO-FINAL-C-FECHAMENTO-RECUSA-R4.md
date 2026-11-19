# Preservação imediata dos estados nas recusas

A rodada parte de `c67a4f46` e ajusta o teste PostgreSQL em `tests/verify-exam-worker-mount.test.ts`.

- **Intenção divergente.** O teste lê a linha inteira do checkpoint antes de chamar `start` com o grant divergente cadastrado e confirma o snapshot da fixture. Imediatamente após `NATIVE_EXECUTION_NOT_ELIGIBLE`, compara a linha persistida com a referência anterior à chamada, incluindo a lista ordenada de intenções pendentes, a época e o horário de atualização. A mesma referência é usada nas provas de rollback e de recuperação pendente.
- **Admissão pelo grant.** O teste lê a linha inteira da admissão cadastrada para o grant, confirma o `job_id` distinto e verifica `state` e `reason` iguais a `admitted`. Imediatamente após `NATIVE_RETIREMENT_UNCONFIRMED`, relê a admissão pelo mesmo grant, incluindo linhas canceladas na consulta, e exige igualdade com a linha anterior à chamada. O teste ainda confere o estado pendente da liquidação antes de remover a fixture, confirma a exclusão e verifica a recuperação final.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test --test-concurrency=1 tests/verify-exam-worker-mount.test.ts` passou com 11 testes e zero pulados. O teste usou o contêiner PostgreSQL sintético `ac-retomada-8f5dddf3-argon-recusa` da R3-SOL. As fixtures criaram bancos temporários a partir de `ac_implementation_test`.
- `git diff --check` passou.
