# Base comum R7 — partida e recuperação de contêineres

O launcher exige um journal antes de preparar o snapshot ou acionar o Docker. O journal registra o token antes de `create` e persiste o ID completo, conferido pelo nome e pelo rótulo de propriedade, antes da transação de partida.

A transação confere principal, reserva e execução em estado `running`, e aguarda a resposta de `docker start` por até 10 segundos, respeitando um timeout menor do coletor. `docker logs --follow` e `docker wait` rodam fora da transação com o tempo restante do mesmo prazo. A leitura limita o stdout e o resultado usa o código de saída observado em `wait`. [Partida sem anexar na CLI](https://raw.githubusercontent.com/docker/cli/master/cli/command/container/start.go), [leitura dos logs](https://docs.docker.com/reference/cli/docker/container/logs/), [observação do término](https://docs.docker.com/reference/cli/docker/container/wait/).

Uma partida sem confirmação conserva o ID se a remoção não puder ser confirmada. Na recuperação, a execução identificada pelo journal é conciliada antes de uma nova coleta. A limpeza confere novamente a propriedade, remove pelo ID completo, confirma a ausência e então limpa as referências do journal. A recuperação de criações incertas continua guardando o token quando o daemon ainda pode entregar um contêiner atrasado.

## Provas

- `npx tsc --noEmit --skipLibCheck` passou com Node 22.23.4.
- `node --import tsx --test --test-concurrency=1 tests/verification-modules-cleanup.test.ts tests/prontidao-cli.test.ts` passou com 15 testes e zero pulos usando PostgreSQL 16.15 descartável, dados sintéticos e Docker simulado.
- A consulta a `pg_blocking_pids` confirmou que a aquisição do sucessor aguardou a resposta de partida. O sucessor adquiriu a reserva com a coleta ainda suspensa no simulador. Quando a aquisição ocorreu antes da verificação da reserva, a execução antiga não chamou `start`.
- A simulação conferiu o timeout de partida e a recuperação do ID persistido pelo sucessor, o timeout e o limite de stdout durante a coleta, e a publicação somente depois de observado o término com código 7. Também verificou perda de resposta de `create`, remoção pendente e montagem da evidência sintética de prontidão.

## Pendências

- A integração com os outros módulos é do gerente. A prova desta rodada é sintética. O comportamento físico do daemon, inclusive a retenção de logs, ficou fora do escopo. O limite de stdout aplicado pela aplicação incide sobre o fluxo recebido. [Configuração de logs do Docker](https://docs.docker.com/engine/logging/configure/).
