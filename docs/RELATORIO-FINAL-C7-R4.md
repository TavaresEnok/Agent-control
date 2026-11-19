# C7 R4 — desempenho na CLI local

## Entrega

- `runPerformanceModule` executa Lighthouse CI, k6, o profiler nativo do V8 e `pg_stat_statements` a partir do snapshot oficial privado do exame. A rotina recebe o caminho já preparado por `prepareModuleSnapshot`, confere a estrutura e a propriedade esperadas e faz uma cópia própria. Monta essa cópia somente para leitura. A cópia aceita até 2.500 arquivos, 10 MiB por arquivo e 128 MiB no total. Exclui links, entradas especiais, diretórios de dependências e nomes comuns de credenciais, com contagem em cobertura.
- O Docker é acionado assincronamente. O sinal de perda de autoridade interrompe a coleta. Criação e partida são operações distintas, de modo que uma criação pendente aguarda a resposta limitada do daemon e um contêiner que ainda não iniciou permanece parado. A limpeza remove o observador, o alvo e o volume temporário e confirma ausência por inspeção. A rotina retenta a remoção e rejeita o resultado quando o daemon não permite confirmá-la.
- Um backend Node elegível roda em contêiner com PID, filesystem e namespace de rede próprios. Alvo e observador usam `--network none`. A comunicação usa loopback em cada lado e um socket Unix num volume temporário de 1 MiB, montado somente para leitura no observador. O observador inicia o tráfego e abre o socket por descritor verificado. O stdout do alvo e os arquivos produzidos por ele ficam fora dos relatórios. A imagem incorpora o código e as ferramentas usadas na coleta.
- `routes[].file` vincula a medição HTTP a um arquivo existente. Lighthouse mede páginas HTML ou rotas declaradas com `page: true`. k6 mede até oito rotas de loopback, com um usuário virtual, três GETs por rota e redirecionamentos desativados. Quando o backend está ausente, não fica pronto ou termina durante a coleta, a rotina procura páginas estáticas válidas no snapshot e registra o recorte. APIs e rotas dinâmicas ficam fora desse recorte. Comparações HTTP com o baseline são omitidas nesse fallback.
- `cpuFunctions` recebe objetos com `file` e `functionName`. O Inspector aciona o profiler nativo do V8 para uma chamada de função autônoma e síncrona, sem argumentos. A evidência registra arquivo, linha de declaração, nome, amostras e tempo próprio estimado. Seleções inválidas, legadas ou incompatíveis produzem cobertura de omissão. Mesmo com resultado válido, a cobertura de CPU é do recorte selecionado.
- PostgreSQL 16 usa cluster descartável em socket privado, carga das migrações com papel restrito e três amostras por instrução, em transações somente leitura revertidas. O coletor associa o tempo medido ao identificador decimal do plano e à origem da instrução. Snapshots externos de estatísticas ficam fora da medição. O baseline continua sendo uma referência declarada pelo snapshot, limitada a pares de métricas comparáveis.

## Chamada para integrar em verification-modules.ts

Na ramificação real do módulo `desempenho`, use o `snapshot` que o exame já criou no escopo externo. Use o caminho de instalação que já resolve o digest do módulo, inclusive na execução compilada. A saída passa pelo validador compartilhado antes da persistência e o chamador mantém a remoção do snapshot oficial no seu `finally`.

```ts
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Dentro da ramificação real de desempenho, com snapshot e image já resolvidos.
const directory = dirname(moduleDigestPath('desempenho', input.rootDir));
const {runPerformanceModule} = await import(pathToFileURL(join(directory, 'orchestrator.mjs')).href);
const result = await runPerformanceModule({
  snapshotPath: snapshot,
  imageDigest: image,
  signal: input.signal,
  timeoutMs,
  maxStdoutBytes,
});
collectorData = validateModuleCollectorObject(result, 'desempenho');
```

O argumento `signal` deve vir do heartbeat da autoridade vigente. A ramificação precisa preservar o tratamento compartilhado de interrupção e as verificações de autoridade antes de publicar. A cópia de trabalho já é removida pelo orquestrador. A mesma função é usada no laboratório com snapshots gerados pelo preparador oficial a partir de commits sintéticos.

## Critérios de aceitação para o gerente

| Recorte | Prova exigida |
| --- | --- |
| Imagem e ciclo Docker | ID local fixado no digest e label `org.agent-control.performance.protocol=4`. Coleta sem sobreposição de código, com observador e alvo em namespaces separados. Ausência dos contêineres e do volume após retorno, falha, timeout e perda de autoridade. |
| Lighthouse CI | LHR da página `/` com score, LCP, CLS e TBT. No defeito, finding de CLS ou TBT associado a `public/index.html`. Controle com cobertura medida e sem achado. |
| k6 | Três requisições observadas por rota. No defeito, p95 acima do limite em `/api/relatorio`, associado a `server.mjs`. Controle medido dentro do limite. |
| CPU | Perfil V8 com amostras e tempo próprio para as duas funções declaradas. Finding no defeito associado ao arquivo e à linha da declaração, obtida da fonte da fixture. |
| PostgreSQL | Medir a consulta rápida e a lenta com os dados das respectivas migrações. Prova de zero chamadas antes e três depois por consulta, com identificador do plano. Finding de tempo na consulta lenta, ligado à linha da instrução lida da fixture. |
| Cobertura parcial | Snapshot com backend ausente conserva a medição da página estática, CPU e SQL. Snapshot vazio registra as quatro ferramentas como omitidas. |

Depois de construir a imagem R4, registrar e conferir seu novo ID no arquivo de digest, rodar a prova de ponta a ponta e revisar a ligação pela CLI. O teste de laboratório em `tests/module-desempenho-lab.test.ts` usa `AC_MODULE_LAB=1` e a rotina de produção. Para HTTP, verifica rota, arquivo e evidência numérica. CPU e SQL derivam as linhas esperadas da fonte da fixture.

## Provas executadas e pendências

- `npx tsc --noEmit --skipLibCheck` passou em Node 22.23.4. Também passaram `node --check` nos módulos JavaScript, `sh -n` no entrypoint e `git diff --check`.
- Os quatro arquivos de teste focados tiveram 26 testes aprovados e um pulado. O profiler V8 mediu 214,6 ms de tempo próprio amostral no defeito e 0,0 ms no controle nesta execução. Os demais testes exercitaram o protocolo e os contadores SQL com dados sintéticos, a conexão HTTP real em loopback via socket local e a orquestração com um processo Docker simulado. As asserções cobrem abandono antes da partida e durante a coleta, retentativa, confirmação de ausência e recusa de resultado quando a ausência é incerta.
- O teste condicional de PostgreSQL 16 descartável ficou pendente por indisponibilidade dos binários locais. A prova conjunta de Lighthouse, k6, CPU e PostgreSQL com Docker, a revisão independente, a ligação em `verification-modules.ts` e a validação pela CLI ficam com o gerente.
- O digest gravado pertence à imagem anterior e permanece no repositório. A rotina exige a imagem R4 e recusa a versão anterior. O laboratório, a suíte completa e a reconstrução da imagem ficaram para a rodada do gerente.
- A origem Git do snapshot é responsabilidade do preparador oficial. As verificações de caminho, dono e modo confirmam a estrutura privada. Exclusões por nome não detectam credenciais embutidas. CPU e SQL medem recortes e HTTP mede as respostas que o backend chega a servir. A prova real deve conferir também o suporte do Docker local ao volume tmpfs e a fronteira do Chromium, que mantém o modo `--no-sandbox` do coletor anterior dentro do contêiner.
