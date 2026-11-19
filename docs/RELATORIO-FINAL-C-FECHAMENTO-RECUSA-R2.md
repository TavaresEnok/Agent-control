# Liquidação anterior ao lançamento em uma recusa Claude

A rodada parte de `f6602e94` e cobre os cinco pontos da revisão de `tests/verify-exam-worker-mount.test.ts`.

- **Atomicidade.** A fixture sem banco restaura as tabelas ao receber `ROLLBACK`. No PostgreSQL descartável, um trigger falha ao atualizar o checkpoint, depois das gravações do job, do recibo, da retirada e da intenção. Logo após `start` devolver `UnstartedExamRetirementPending`, o grant já está liberado com o recibo físico. O job continua `uncertain` e sem recibo terminal, a intenção está `accepted`, a retirada está ausente e o checkpoint conserva o conteúdo e o horário anteriores. A recuperação encontra a mesma falha enquanto o trigger está ativo e conclui depois que ele é removido.
- **Admissões.** A fixture em memória dispensa a regra genérica que devolvia vazio para qualquer SQL de admissão. No PostgreSQL, uma admissão ativa aparece na consulta pelo grant e impede `recoverUnstartedExam`. O `DELETE … RETURNING` confirma a remoção da linha. A consulta fica vazia e a recuperação conclui.
- **Vínculos de `start`.** As tentativas de montagem e recusa passam pelo `identity` real. O caso em PostgreSQL verifica as recusas para outro coproprietário, uma instância de autoridade diferente e uma intenção aceita que pertence ao mesmo principal mas diverge do grant. Cada recusa ocorre antes de registrar o job ou consultar o socket Docker sintético.
- **Inspeção inconclusiva.** O caso sem banco lê o grant e o recibo físico imediatamente após a recusa de `start`. A recuperação genérica ainda devolve `network_unproven`. Depois que a inspeção volta, `recoverUnstartedExam` produz um job `failed` com recibo assinado, uma retirada `removed`, a intenção `failed` e o checkpoint sem a intenção encerrada. A verificação do spool exige `ENOENT`.
- **Ordenação do checkpoint.** As intenções pendentes têm horários explícitos e UUIDs fora da ordem cronológica. O caso em PostgreSQL inclui duas intenções com o mesmo `created_at`, inseridas em ordem inversa à dos IDs, para verificar também o desempate por ID.

## Verificação

- `node --import tsx --test --test-concurrency=1 tests/verify-exam-worker-mount.test.ts` com Node 22.23.3 e PostgreSQL 16 descartável. Os 11 testes passaram.
- O mesmo comando sem `AC_TEST_DATABASE_URL` teve 9 testes aprovados e 2 pulados por exigirem PostgreSQL.
- `npx tsc --noEmit --skipLibCheck` passou.
- `git diff --check` passou.
