# Rodada A1-R15 — capacidade e limpeza da reverificação

A rodada partiu de `bd5ad68d`. O worktree estava limpo e as mudanças da R14 serviram de base para os três ajustes da ordem.

- Na segunda revisão de um achado alto, a reserva conta as concessões ativas sob a trava transacional de capacidade. A escolha usa a ordem de preferência já existente entre contas com vaga. Com B lotada, usa um perfil permitido em A se houver vaga. Com todas as contas lotadas, mantém a tentativa em `CAPACITY_BUSY` no perfil inicialmente preferido. A reserva bem-sucedida remove a espera da própria tentativa.
- `examReviewer` exige papel `specialist` e provedor `claude` explícito. O esquema recusa papel diferente, outro provedor ou ausência de provedor.
- A reverificação reutiliza `finishExamIntentTx` para finalizar a intenção temporária, atualizar o checkpoint e remover as esperas dessa intenção na mesma transação. A limpeza idempotente permite até três tentativas. Se a operação e a limpeza persistente falharem, o `AggregateError` mantém o erro da operação e o último erro da limpeza.

## Validação

- `npx tsc --noEmit --skipLibCheck` passou com Node 22.23.4.
- Os 13 testes e subtestes de `tests/personal-reserve.test.ts` e `tests/verify-remediate.test.ts` passaram em uma instância descartável separada de PostgreSQL 16, com entradas sintéticas.
- Duas reservas de contextos distintos disputaram a última vaga em A enquanto B estava lotada. Uma obteve o perfil permitido em A e a outra manteve uma única espera em B. Depois de liberar uma vaga em B, a repetição da mesma tentativa obteve a reserva e deixou a fila vazia.
- A falha transitória simulou a perda da confirmação depois do commit da limpeza. A repetição manteve a intenção em `failed`, com a espera já removida, e propagou o erro original. Com três falhas persistentes, ambas as causas ficaram disponíveis e a transação deixou a intenção em `accepted` com sua espera, para recuperação posterior.
