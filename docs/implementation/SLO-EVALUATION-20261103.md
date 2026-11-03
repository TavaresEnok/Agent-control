# Avaliação de SLOs sobre o snapshot operacional — 03/11/2026

## Entrega

`evaluateOperationalSlos` em `src/slo-evaluation.ts` é uma função pura. Ela aplica o catálogo versionado `catalogVersion: 1` a um único `OperationalSnapshot` já produzido por `src/observability.ts`. Não consulta PostgreSQL, não mede disco, não abre scrape, não envia alerta e não altera filas, grants ou admissão. O relógio entra somente pelo argumento `now`. A função não chama `Date.now()`. Omitir `now` produz `evaluation_clock_invalid` em todos os SLOs.

Cada SLO sai sempre, na ordem fixa do catálogo, com `status` `ok`, `violated` ou `unknown`, `reason` de um conjunto fechado, `margin` ou `null`, e `window`. A margem é um inteiro com sinal: valor maior ou igual a zero cumpre o objetivo. A decisão de taxa compara a fração exata com o limite, por produto cruzado, antes de arredondar. A margem em ppm é o limite menos a taxa truncada para baixo. Se a fração exata ultrapassa o limite e essa truncagem deixaria a margem em zero ou positiva, a margem fica `-1` e o estado fica `violated`. O mesmo snapshot e o mesmo `now` produzem o mesmo relatório. O relatório não copia help, labels, paths, principals, contas ou texto livre.

A janela é o instante do snapshot (`snapshot_point`). O limite de frescor é 300 segundos. A comparação usa a diferença em milissegundos contra 300000 e só depois trunca a idade exibida para segundos inteiros. Não é uma série histórica nem uma janela de eventos.

## Objetivos de bancada, versão 1

Estes números são política do avaliador para a bancada. Não são meta homologada, não provam RNF-12 e não aceitam nenhum dos 111 requisitos.

| SLO | Sinal | Objetivo | Margem |
|---|---|---|---|
| `manager_availability` | `agent_control_managers` (`leased`, `stale`, `missing`) | 100% `leased` quando a população é maior que zero | ppm observado menos 1_000_000 |
| `dispatch_latency` | `agent_control_dispatch_oldest_pending_seconds`, uma amostra sem labels | no máximo 2 segundos | 2 menos o valor observado |
| `queue_backlog` | `agent_control_capacity_waits`, todos os motivos fechados | soma no máximo 100 | 100 menos a soma |
| `pending_receipt_age` | `agent_control_pending_receipt_oldest_seconds`, uma amostra sem labels | no máximo 3600 segundos | 3600 menos o valor observado |
| `infrastructure_failure_rate` | `agent_control_operations`, série fechada de todos os escopos do coletor; a taxa lê só `implementation` | no máximo 50_000 ppm | 50_000 menos a taxa |

O coletor atual emite gerentes, esperas de capacidade e operações. Não emite os dois gauges de duração. Sem esse sinal, latência de despacho e idade de recibos ficam `unknown` com `required_signal_absent`. Ausência não vira zero e não vira `ok`.

A série de operações do coletor é o produto cartesiano dos estados de `metricStates.operations` com os cinco escopos do laço em `src/observability.ts`: `implementation`, `stage`, `sandbox`, `remote` e `integration`, cada um com `registered`, `running`, `uncertain`, `completed`, `failed`, `integrated`, `rejected`, `canceled_confirmed` e `other`. O avaliador exige essa série inteira. Snapshot só com `implementation`, escopo removido ou estado removido dentro de um escopo é `signal_incomplete`. Isso nunca fica `ok`. Os outros SLOs que estariam `ok` passam a `unknown` com `snapshot_incomplete`. A taxa não soma escopos sobrepostos: `sandbox` com muitas falhas não altera o numerador de `implementation`, mas a amostra de `sandbox` tem de estar presente.

`agent_control_capacity_wait_oldest_seconds` e a contagem do outbox não entram nestes SLOs. Idade de espera de capacidade não é latência de despacho nem idade de recibo. O próprio help do outbox diz que a contagem não é SLO de entrega.

A taxa de infraestrutura é `failed / (failed + completed + integrated)` no scope `implementation`, e só é calculada depois que os cinco escopos estão fechados. Reprovações (`rejected`) ficam de fora do numerador e do denominador: não são falha de infraestrutura e não diluem a taxa. `registered`, `running`, `uncertain` e `canceled_confirmed` também ficam fora da taxa. Scopes se sobrepõem e não são somados. `other` maior que zero no scope `implementation` torna o SLO `unknown`. População terminal vazia, inclusive quando só há reprovações, é `no_population`, não taxa zero. `50001 / 1000001` é maior que `50000 / 1000000` e fica `violated` com margem `-1`, embora a taxa truncada seja 50000 ppm. `1 / 20` fica no limite, com margem `0`. `50000 / 1000001` fica abaixo, com margem `1`.

Contexto sem nenhum gerente contabilizado é `no_population`, não disponibilidade de 100%. Essa população vazia está fechada e não impede `ok` nos outros SLOs. Motivo de fila ausente não é zero. Label fora do conjunto fechado, label extra, amostra duplicada ou duração com labels torna o SLO afetado `unknown` e também impede `ok` nos demais.

## Quando nenhum SLO pode ficar ok

- Snapshot `null` ou `undefined`: `snapshot_absent`.
- Forma inválida, `schemaVersion` diferente de 1, scope diferente, leitura que não é somente banco, disco fora do enum, métrica duplicada ou que não é gauge, valor que não é inteiro decimal de até 18 dígitos, ou label fora das chaves fechadas do coletor: `snapshot_incomplete`.
- `observedAt` que não é o instante ISO com milissegundos e sufixo `Z` emitido por `toISOString`, ou que não fecha a volta: `snapshot_timestamp_invalid`.
- Relógio de avaliação ausente ou inválido: `evaluation_clock_invalid`. Ausência de `now` não lê o relógio do processo.
- Snapshot no futuro: `snapshot_clock_ahead`.
- Diferença estritamente maior que 300000 milissegundos: `snapshot_stale`, mesmo que os números violassem ou cumprissem o objetivo e mesmo que a idade exibida, já truncada, seja `300`. Idade de 300000 milissegundos ainda pode ser avaliada. 300001 milissegundos e 300999 milissegundos são `snapshot_stale`.

Um snapshot estruturalmente incompleto deixa todos os SLOs `unknown` com `snapshot_incomplete`.

Série fechada parcial, duplicada ou com rótulo fora do catálogo (`signal_incomplete`, `unclassified_samples`, `value_invalid`) também torna o snapshot incompleto para o catálogo inteiro. Isso inclui operação sem um dos cinco escopos do coletor, ou sem um estado dentro de qualquer desses escopos. O SLO afetado conserva o motivo específico. Qualquer outro SLO que estivesse `ok` passa a `unknown`, com `snapshot_incomplete` e margem nula. `violated` e `no_population` permanecem: a regra impede `ok` e não esconde um objetivo já perdido nem uma população vazia bem formada.

Ausência total de um gauge que o coletor emite (`required_signal_absent` em `manager_availability`, `queue_backlog` ou `infrastructure_failure_rate`) impede `ok` nos demais da mesma forma. Ausência total dos dois gauges de duração, que o coletor ainda não emite, continua local: só aqueles SLOs ficam `unknown` com `required_signal_absent`. Essa ausência não vira zero e não vira `ok`, e não retira `ok` de um snapshot em que as séries emitidas estão completas.

## Prova executada

Diretório: esta worktree. `PATH` com `/home/app/.local/share/node24/bin`. Node `v24.22.1`. O `package.json` do Agent Control declara `>=22.23.3 <23`; a prova usou o Node indicado para a preparação.

`upstream/cezar/node_modules` e `upstream/cezar/packages/cezar/dist` já existiam nesta rodada. `npm ci` e `npm --prefix upstream/cezar run build:server` não foram executados. O typecheck do Agent Control não depende desse build.

`npm run typecheck` (`tsc -p tsconfig.json --noEmit`) terminou com exit 0. O aviso `Unknown env config "store-dir"` veio do npm e não altera o exit.

`node --import tsx --test --test-concurrency=1 tests/slo-evaluation.test.ts` terminou com exit 0. Dez testes passaram, nenhum skip, `duration_ms` 295.380568. Os casos usam snapshots sintéticos em memória: a série de operações do avaliador é a mesma que o coletor emite, cumprimento no limite com os cinco escopos fechados, violação com margem, reprovação que não dilui falha de infraestrutura, scope sobreposto ignorado na taxa, snapshot ausente, antigo, adiantado, vazio, incompleto e com label de alta cardinalidade, série de gerentes sem todos os estados, gauge emitido ausente, fila violada ao lado de série parcial de gerentes, snapshot só com `implementation`, cada escopo de operação removido e cada estado removido dentro de um escopo, duas avaliações iguais com métricas e amostras invertidas, `now` omitido sem leitura de relógio, taxa `50001/1000001` e idade de 300999 milissegundos. Nenhum desses casos deixa `ok` quando o snapshot está ausente, antigo ou incompleto. A ausência isolada dos gauges de duração ainda não emitidos deixa só esses dois SLOs `unknown`. Nenhum teste abre PostgreSQL, Ruby ou Docker. Não há prova de banco: o que exigiria PostgreSQL permanece fora desta entrega.

## Limites

- Não há coleta real, scrape, Prometheus, Grafana nem alerta externo. Não há rota HTTP nova.
- Não há prova com banco, filesystem ou relógio de produção. O snapshot sintético não substitui o coletor.
- A frescura de 300 segundos e os tetos de fila, recibo e taxa são política de bancada da versão 1. Não medem aceite de comando em 2 segundos nem atualização de evento em 5 segundos no ambiente homologado: o coletor não publica essas durações.
- Um ponto no tempo não demonstra cumprimento contínuo, throughput, RPO, RTO nem prontidão de produção.
- Lease `leased` continua sem provar processo vivo. Falha de operação não separa causa física além dos estados já fechados do coletor.
- Esta entrega não homologa RNF-12, I7, restore, retenção, piloto ou migração. Não aceita os 111 requisitos por contagem de testes. O programador não aprova a revisão.
