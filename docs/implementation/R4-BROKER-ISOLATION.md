# R4 — matriz finita de isolamento adversarial do broker

Base de trabalho `814ca058`. Escopo autorizado: SandboxBroker real com dois workers físicos sintéticos concorrentes, central local e administração assinada de ambiente079. Não é prova integral do runtime nativo ou de contas oficiais. Não modifica a matriz global nem aceita requisitos em lote.

## Cobertura existente reutilizada como evidência, sem reexecução

| Cobertura | Fonte existente | Limite que orientou o novo ensaio |
| --- | --- | --- |
| Dois contêineres reais leem a própria credencial sintética e não leem a outra por shell, symlink e /proc; namespaces PID distintos | `tests/native-credential-isolation-physical.test.ts` | Criação manual de contêineres; não compõe administração legítima da central |
| Worker criado pelo broker sem socket administrativo, credencial vizinha ou rede; MAC forjado recusado | `tests/sandbox.test.ts` | Um worker e probe simples |
| Ponte de tools só encaminha ao peer fixado | `tests/native-tool-forwarder.test.ts` | Transporte, sem jornada adversarial composta |
| Administração assinada recusa principal externo, assinatura falsa, escape de path e symlink; replay e concorrência | `tests/project-admin.test.ts` | Serviço/API sem workers físicos simultâneos |
| Supervisor nativo com grafo concorrente e recuperação física | `tests/native-graph-physical-recovery.test.ts` | Não é o ensaio hostil aqui executado; esta entrega não altera esse supervisor |

## Transições novas e controles positivos

| Transição | Assertiva finita |
| --- | --- |
| Dois jobs admitidos, concedidos e lançados pelo broker real | Dois contêineres running, grants running, namespaces PID distintos, network none, rootfs ro, mounts somente /work e script fixo ro |
| Shell e chamadas FS diretas tentam canário central, canário sintético de conta, fonte/ref Git de outro projeto, worktree do peer e caminhos /proc/root | Sete alvos × cinco ataques (read/write/symlink-read/symlink-write/shell), todos recusados; próprio canário legível e saída autorizada gravável |
| Processo/sockets/API a partir do worker | Sinal ao PID real do heartbeat e /proc/PID/mem recusados; três sockets ausentes; TCP HTTP central falha por isolamento de rede. Isso não constitui uma resposta HTTP401 do worker |
| Counterprobes host na API real, separados da falta de rede do worker | Sem cookie401; prova humana forjada403; owner tentando projeto alheio403; owner de projeto tentando registro administrativo central403; reconfiguração do projeto com grants vivos409 |
| Operação legítima durante os ataques | Owner publica ambiente079 em outro projeto autorizado ocioso enquanto ambos os workers continuam running; source/ref/canários centrais intactos, nenhuma alteração da tabela de administradores ou registro global |
| Conclusão legítima dos workers | Liberação explícita do barrier, saída autorizada preservada, recibo terminal do broker exit0, grants released e cleanup |
| Ciclo de vida do controlador | Parada explícita não altera exitCode; perda real do backend PostgreSQL detentor do lock termina um controlador filho com exit1 |

Cada worker faz 42 verificações: 41 recusas de ataque e um controle positivo de leitura/escrita local. O teste usa fixtures sintéticas e um script fixo com SHA256 verificado pelo broker; não fornece shell ou montagem arbitrária à API do broker.

## Achado demonstrado e correção separada

A primeira execução corrigida chegou a todas as assertivas físicas e publicou a revisão079, mas o arquivo terminou com exit1 após o subteste passar. `brokerMain.stop()` executava `lock.release(true)`; o listener de `end` classificava esse fechamento solicitado como perda de autoridade e definia `process.exitCode=1`. A correção separada `429a0bf2` marca shutdown esperado antes do teardown. Eventos inesperados ainda chamam stop e definem exit1. O teste final inclui contraprova com `pg_terminate_backend` do PID exato do advisory lock, em processo filho, sem manipular o exitCode do processo de teste.

Outro resultado negativo foi esperado: ambiente079 recusa configurar o próprio projeto enquanto há grants ativos (`PROJECT_ENVIRONMENT_IN_USE`). O teste preserva a guarda e publica legitimamente em projeto autorizado ocioso; não remove proteção para obter um passe. Os outros logs negativos documentam cache de workflow ausente e cadastro inicial do dispositivo usando ator sem privilégio de enrollment; foram corrigidas as fixtures.

## Execução e estado honesto

Requer Node22.23.3, Docker local com imagens já existentes `node:22-alpine` e `postgres:16-alpine`, dependências raiz e saída de workflows Cezar. O controlador do broker precisa de root para chown dos diretórios/sockets descartáveis; os workers permanecem UID10001. O teste recusa executar sem opt-in e cria somente PostgreSQL, contêineres, processos e paths próprios identificados aleatoriamente.

```
sudo -n env AC_R4_BROKER_ISOLATION=1 PATH=/tmp/node-v22.23.3-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /tmp/node-v22.23.3-linux-x64/bin/node --import tsx --test tests/r4-broker-authority-isolation-physical.test.ts
```

Na janela serial autorizada pelo principal, a execução final passou **1/1, zero skips, exit0**, em7,59s. `r4-broker-isolation-author.log` registra ambos os workers físicos, a publicação legítima e a contraprova de lifecycle normal/perda real de lock. O arquivo negativo anterior foi preservado como `r4-broker-isolation-before-shutdown-fix.log`; não foi renomeado para passe. O typecheck TypeScript normal (`npm run typecheck`, sem skipLibCheck) passou, exit0. A primeira tentativa encontrou apenas cache parcial da workspace Cezar/Zod; seu log foi preservado, e a dependência local correta foi ligada antes do check final. Sintaxe do probe e diff foram conferidos. Nenhum bypass de isolamento foi reproduzido; a única mudança de produto é o teardown do broker. A bancada final removeu os dois workers, PostgreSQL, heartbeat, processo filho e scratch próprios; a consulta final não encontrou container/processo de sua identidade. O parecer independente `cf800596` aprovou a correção e a prova neste escopo delimitado após revisão de fonte e inspeção do log da execução serial autorizada. Ele atribui1/1 ao autor observado, sem inventar reexecução independente ou aceite de isolamento nativo amplo.

## Limites por requisito

RF29/49, RNF03 e T15/23/24/36 recebem uma contraprova delimitada de broker/central, sem aceite integral. Não é SSH hostil completo, execução nativa completa, WS/MCP protocolar autenticado, root escape homologado ou ataque de CLI oficial. Nenhuma credencial real, inferência paga, deploy ou migração operacional foi usada. O autenticador upstream é uma fixture explícita de token sintético; armazenamento e revalidação do cookie, gateway, membership, prova Ed25519, CAS e backend079 são código de produto. Workers não recebem o token, cookie ou chave do operador.
