# Intervalos de recuperação dos supervisores nativos — 03/11/2026

Os supervisores de planejamento e de execução observam o job já gravado. `recover` não chama `create` nem `start`. Um recibo terminal já persistido é relido; não há outro efeito. O bootstrap continua default-off e com ativação bloqueada. SQL 042 e Capacity não foram alterados. Nenhuma conta real, inferência, deploy ou migração entrou nesta rodada.

Esta nota não homologa o caminho nativo e não promove os 111 requisitos. O programador não aprova a revisão.

## Intervalos cobertos

- **Perda de resposta ao stop ou ao Docker.** `stop` devolve `uncertain` quando o Docker responde `DOCKER_*`, quando o contêiner já não está, ou quando um dos pares está ausente. O grant não muda. A inspeção seguinte que falha, inclusive depois de um `remove` já feito, devolve `docker_response_lost` e não libera o grant.
- **Queda entre o lançamento e a evidência terminal.** Contêiner ainda em execução, ou par que não está `exited` dos dois lados, permanece `before_terminal_evidence`. Não cria substituto. A prova desta rodada chama `execute` ou `start` do supervisor, segura a resposta de `create`/`start` numa barreira e só então rejeita o efeito. Enquanto a barreira está ocupada, `recover` do mesmo processo fica na fila `serialEffect` e não inspeciona nem libera. O sucessor é outra instância, com o mesmo journal. Sem corpo, o grant fica (`terminal_evidence_missing` no planejamento, `network_unproven` na execução). Se o `start` marca o corpo como em execução antes de perder a resposta, o grant fica e nada é removido. Se o corpo continua `created` com `Pid=0` e `StartedAt` em `0001-`, a recuperação que esperava na fila libera uma vez. Outra instância, no mesmo journal, devolve esse estado e não chama `create`/`start`. Um `process.exit(137)` isolado continua no teste antigo só como controle negativo: não é lançamento nem recibo.
- **Worker já terminado e ferramentas ainda em execução.** `recover` não devolve `before_terminal_evidence` antes do reconciliador. O reconciliador pede `stop` das ferramentas. Se o `stop` perde a resposta, as ferramentas seguem `running` e o grant fica. O `stop` seguinte encerra as ferramentas e o grant ainda fica, porque o recibo só nasce quando os dois lados já estão `exited`. A observação seguinte, feita por outro supervisor com a mesma chave e o mesmo journal, grava o recibo e não chama `create` nem `start`.
- **Contêiner ou rede remanescente.** Contêineres só são removidos quando todos os corpos presentes estão provados como não iniciados (`Status=created`, `Running=false`, `Pid=0`, `StartedAt` vazio ou `0001-`) e nenhum id registrado está sem corpo. Pid ou horário ausente não é prova e bloqueia a remoção. Rede que ainda existe mantém o grant (`network_or_container_remains`), mesmo depois de remover os contêineres não iniciados. `DockerDaemon` não oferece remoção de rede.
- **Troca de gerente ou de época.** A época antiga é recusada com `STALE_MANAGER` e o grant fica. O sucessor observa o job original. Outra chave ou outro digest devolve `supervisor_identity` sem efeito Docker.
- **ACK perdido.** Com os dois contêineres (ou o de planejamento) `exited` e saída utilizável, a primeira observação grava o recibo da época e da sessão originais. A seguinte devolve o mesmo recibo e não inicia outro efeito. Saída zero sem arquivo de resultado mantém o grant (`terminal_evidence_missing`).
- **Liberação só com prova de não início.** O journal continua anterior ao `create`. Um ou dois 404, sem corpo observado, não provam que o `create` não foi enviado: o grant fica `uncertain`/`reserved` e o recibo não ganha `executionStarted:false`. Se o corpo aparece depois desses 404, a mesma recuperação não o apaga. A liberação só ocorre com o lock do job/grant ainda aberto, fence revalidado, corpo `created` na inspeção imediatamente anterior ao `remove`, segundo inspect ausente e, na execução, `network_id` conhecido com rede já ausente e sem `launch.json`. `network_id` nulo fica `network_unproven`.
- **Janela entre a inspeção `created` e o `remove`.** O `start` original e a recuperação entram na mesma fila do processo e disputam a mesma linha de job/grant. Se, ainda assim, o substituto inicia e encerra o contêiner entre as duas inspeções, o `remove` não é chamado e o grant não sai como não iniciado. Troca de época nessa janela falha com `STALE_MANAGER` antes do `remove`.

## Intervalos não cobertos

- Socket Docker real, processo de modelo, conta, proxy de provedor ou rede de produção.
- Apagar a rede privada. O contrato atual de `DockerDaemon` não tem essa operação.
- `DELETE` sem condição no daemon. Um cliente externo, que não passa pelo lock do grant/job, ainda pode iniciar e encerrar o contêiner entre a última inspeção e o `remove`.
- Morte do processo do supervisor por sinal do sistema operacional. A prova interrompe a promessa de `create`/`start` e a fila do mesmo processo; não envia SIGKILL ao processo que está dentro de `start` ou `execute`.
- O ledger substituto não executa os triggers de imutabilidade do PostgreSQL. A cópia que abre banco real permanece no arquivo e não rodou: faltam `AC_TEST_DATABASE_URL` e `AC_SANDBOX_DATABASE_URL`. Ela exige o mesmo contrato mais estrito (404 sem corpo não libera). Elegibilidade, home da conta e snapshot Git do lançamento interrompido também são substitutos: o efeito real exercitado é `create`/`start` do supervisor.
- Intervalos de QA, origem de mounts depois da inspeção, retenção de snapshots e qualquer ativação do bootstrap.
- Os testes de SIGKILL do grafo sintético continuam condicionados a `AC_SANDBOX_DATABASE_URL` e não fazem parte desta prova.

## Provas desta rodada

Ambiente sem `AC_TEST_DATABASE_URL` e sem `AC_SANDBOX_DATABASE_URL`. Node `v24.22.1` em `/home/app/.local/share/node24/bin`. A bancada dos intervalos usa ledger em memória e Docker injetado. O substituto devolve `created` na primeira inspeção e só então marca `exited` ou troca a época. O create atrasado entra no mapa depois do 404 e não durante ele. As barreiras de lançamento seguram as chamadas reais de `create`/`start` e a fila `serialEffect`. Não houve socket Docker nem modelo.

- `npm run typecheck`: exit 0.
- `node --import tsx --test --test-concurrency=1 tests/native-recovery.test.ts`: exit 0. Três testes passaram: o gate do worker, a recuperação de planejamento no substituto e a interrupção de `create`/`start` com sucessor no mesmo journal. Dois testes antigos de SIGKILL do grafo sintético seguem em skip, à espera de `AC_SANDBOX_DATABASE_URL`. Não foram reescritos e não provam os intervalos novos.
- `node --import tsx --test --test-concurrency=1 tests/native-execution-supervisor.test.ts`: exit 0. Três testes passaram no substituto: a recuperação já existente, o worker `exited` com ferramentas `running` (perda de `stop` e recibo posterior sem `create`/`start`) e a interrupção de `create`/`start`. O teste que abre PostgreSQL ficou em skip porque `AC_TEST_DATABASE_URL` não está definida.

Não houve modelo, conta real nem socket operacional. A revisão independente continua necessária.
