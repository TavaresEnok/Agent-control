# C7 — cancelamento do histórico de desempenho, R4

O trabalho partiu de `8ab6b01b` e tratou os cinco achados de `parecer-high-C7-HISTORICO-R3.txt`. A execução foi individual no worktree `task/final-c7-hist-r4`, sob a ordem de equipe de `b4e622df`.

## Alterações

- Cada página identifica a sessão PostgreSQL dentro da transação e mantém o cliente reservado até concluir a tentativa de interrupção. No abort, uma conexão auxiliar com a mesma configuração sinaliza o backend identificado por PID, início da sessão, banco e usuário. O PostgreSQL termina essa sessão e desfaz a transação. A conexão auxiliar funciona mesmo com todas as vagas do pool ocupadas. [Funções de sinalização do PostgreSQL 16](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)
- A aquisição aguarda capacidade fora da fila interna do pool e respeita o sinal durante a espera. Os pedidos já enfileirados mantêm prioridade. Se uma conexão física já iniciada terminar após o abort, o cliente é devolvido ao pool. A página que completa o `COMMIT` devolve o cliente antes de entregar as medições. [API de pool do node-postgres](https://node-postgres.com/apis/pool)
- O orquestrador aplica o mesmo sinal a `next()` e à espera de fechamento antecipado. Se `next()` informar `done: true`, a enumeração termina sem chamar `return()`. A prova de prazo mantém `return()` pendente durante o cancelamento e verifica que sua rejeição tardia é tratada e o registro pode ser reconciliado.

## Provas

- `npx tsc --noEmit --skipLibCheck` passou com Node 22.23.3.
- `node --import tsx --test tests/module-performance-history.test.ts tests/module-desempenho-orchestrator.test.mjs` passou com 36 testes, incluindo subtestes, sem falhas, cancelamentos ou testes pulados.
- A prova de banco usou PostgreSQL 16.15 nativo, em um cluster temporário no loopback, com papel sintético sem privilégio de superusuário. `client_connection_check_interval`, `statement_timeout` e `lock_timeout` estavam em zero. O teste identificou em `pg_stat_activity` o PID e a transação do `SELECT` de medições. Após o abort, o PID `702459` saiu da visão enquanto o PID bloqueador `701066` mantinha `AccessExclusiveLock` sobre `ac_verify_runs`. A sessão de observação `702364` continuou ativa. O teste de aquisição verificou a rejeição com a razão original, fila vazia e todos os oito clientes ainda operacionais antes da devolução.
- O teste do orquestrador cobriu uma fonte esgotada cujo `return()` falharia se chamado e outra cujo `return()` nunca terminava antes do prazo. O primeiro lançamento desse segundo teste expôs que o timer de `AbortSignal.timeout()` não mantém o processo sintético ativo por si só. O teste passou a manter ativo seu próprio limite de segurança até o prazo em verificação disparar.

## Limite da prova

A interrupção confirmada no servidor requer que o PostgreSQL aceite a conexão auxiliar. Se a abertura dessa conexão falhar, o código descarta o cliente local e preserva o motivo do abort. O fim imediato do backend nesse cenário fica sem garantia.

A validação ficou restrita ao banco descartável e aos dois arquivos de teste. Na preparação houve uma listagem local de metadados do Docker. A prova de banco usou binários extraídos em diretório temporário, e o orquestrador usou apenas o executável Docker simulado dos testes. O cluster temporário foi desligado após a prova.
