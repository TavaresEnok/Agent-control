# R3 — fluxo de produto com inferência determinística

A capacidade de bancada em `src/native-synthetic-fixture.ts` permite ligar os supervisores nativos a identidades **synthetic** sem retirar os bloqueios de provedores operacionais. Ela só nasce por chamada de código confiável: um objeto JSON com os mesmos campos é recusado. A emissão inspeciona imagens por digest e uma rede Docker interna, exigindo o mesmo label `agent-control.synthetic-fixture=ac-r3-flow-*`; tem timeout de 15 segundos. O token imutável fica registrado por identidade em WeakSet e vincula imagens, rede, projeto e contexto. O esquema de instalação continua sem opção serializável capaz de emitir esse token.

Os dois supervisores mantêm os caminhos de capacidade PostgreSQL, elegibilidade publicada pelo produto, identidade de conta/perfil, HOME por inode, fencing, autorização e journal físico. A ramificação de bancada admite apenas `provider=synthetic-engineering`, `mode=synthetic`, com sujeito correspondente. A ramificação operacional continua exigindo Codex/subscription_cli e continua bloqueada pelo bootstrap/SQL. Recibos produzidos pela bancada passam a declarar `synthetic=true`. Não há `ALTER TABLE`, desativação de trigger, troca transitória de modo nem mock de capacidade/elegibilidade/HOME.

## Execução reproduzível

Pré-requisitos locais já preparados: Node oficial 22.23.3, Ruby `/usr/bin/ruby`, Git, Docker Compose, imagem local `postgres:16-alpine`, imagem local `agent-control-lab:0.1.0`, ELF público local Codex 0.166.0 com hash explícito e dependências/build vendorizados Cezar/Happier. O runner recusa dependências ausentes; não faz login, download de CLI de IA ou instalação operacional. Nesta máquina, o ELF público fica em `/home/app/.local/share/node24/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`; a imagem base existente tinha ID `sha256:9914706a4d692f9e87c9c17313efbf3f0544574e1ebc3ddf77512a54eb5cb7b3`.

No checkout com os builds/dependências preparados:

```sh
export PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH
node --import tsx --test tests/r3-synthetic-capability.test.ts tests/r3-flow-image.test.mjs
AC_R3_FLOW_PUBLIC_CODEX_BINARY=/CAMINHO/ABSOLUTO/DO/ELF/publico/codex \
AC_R3_FLOW_PUBLIC_CODEX_SHA256=b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8 \
node scripts/r3-flow-isolated.mjs
```

Em uma worktree nova nesta bancada, as dependências Happier já existentes podem ser ligadas reversivelmente pelo helper auditado, com manifesto exclusivo:

```sh
mkdir -p upstream/happier/node_modules/@happier-dev
node scripts/link-happier-test-deps.mjs install /tmp/ac-close-base/upstream/happier /tmp/ac-r3-flow-deps-MEU-ID.json
# Depois do ensaio, remover apenas os links do manifesto:
node scripts/link-happier-test-deps.mjs remove /tmp/ac-r3-flow-deps-MEU-ID.json
```

O runner imprime os diretórios privados de scratch e logs. Cria projeto Compose `ac-r3-flow-<uuid>`, PostgreSQL exclusivo em loopback, Happier light com SQLite e HOME temporários, imagem de fixture com label exclusivo e rede provider interna exclusiva. Só passa uma allowlist de ambiente aos processos: não herda tokens, chaves, proxies ou `NODE_OPTIONS`. A construção da fixture não usa rede e exige a imagem base local. O preparador verifica arquivo regular, caminho real, cabeçalho ELF e SHA-256 antes de incluir apenas esse binário público e os bundles de código no contexto privado. Não copia HOME ou configuração CLI. O comando `codex --version` é conferido em contêiner sem rede; o hash e a versão aparecem na evidência. A limpeza tenta remover seus próprios contêineres, redes, tag da imagem, banco e scratch, preservando os logs externos. Falhas de limpeza tornam o comando não verde.

## Percurso exercitado

O teste cria autenticação criptográfica real no Happier, máquina e conversa E2EE. Um pedido criptografado entra no `HappierEndpoint`, que pede plano ao `SemanticPlanning`. O `NativePlanningSupervisor` reserva capacidade real, verifica elegibilidade/HOME reais e inicia contêiner físico. O planejamento determinístico devolve alpha/beta independentes e gamma dependente de ambas; a proposta não inicia implementação.

O usuário de bancada obtém uma sessão de navegador pelo endpoint real de `BrowserSessions`: o bearer é validado em `/v1/account/profile` no Happier. As mutações seguintes usam cookie HttpOnly, Origin e autorização de projeto. A configuração de execução é publicada por comando assinado; `/api/v1/ac/commands` admite a proposta congelada. O grafo Cezar lança três programadores, composição, quatro QA físicos e quatro revisões independentes de fixture, integra a referência Git protegida e publica conclusão no histórico canônico criptografado. O teste descriptografa a resposta do servidor, confere a conclusão e reconecta o endpoint, verificando recuperação do pedido e da notificação sem duplicar o pedido.

Outro plano publicado pelo endpoint contém dois programadores físicos mantidos ativos pela inferência determinística. Um controlador Node separado despacha o grafo. O teste verifica os dois workers `Running`, pausa pelo controle assinado, mata o controlador com SIGKILL e verifica os mesmos IDs ainda `Running`. O sucessor aguarda a expiração real do lease PostgreSQL, adquire epoch maior, reabre runtime/API e verifica pausa preservada e ausência de novos jobs. Cancelamento passa pela API autenticada com prova Ed25519. A reconciliação física confirma parada, retirada e zero grants restantes. Pedido sem prova, assinatura forjada e Origin incorreta são recusados sem criar cancelamento.

Há contraprovas para pin ausente, SHA-256 divergente e symlink de ELF público antes de qualquer comando de construção; token JSON/clonado, imagem/contexto divergentes, HOME inseguro e tentativa de mudar conta sintética para modo operacional sob o trigger intacto. O teste unitário também recusa provider operacional no contrato e label fora da bancada.

## Limites e evidência

As substituições são explícitas: saída determinística dos workers de planejamento/programação/revisão; e alocação de subnet privada para evitar o pool Docker local já ocupado. Os workers da fixture verificam assinatura e prazo do launch. QA executa comando real, e snapshots, finalização, artefatos, revisão registrada, retirada e integração Git passam pelos módulos reais do produto. A infraestrutura de ferramentas agora usa o `native-tools-worker.ts` real e o ELF público Codex 0.166.0 (`b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8`), em contêiner separado. O modelo determinístico usa WebSocket autenticado por capability token e RPCs reais `initialize`, `initialized`, `fs/createDirectory`, `fs/writeFile` e `fs/readFile`; confirma leitura igual à escrita. Token incorreto é recusado pelo servidor real, `/account` está ausente no contêiner de ferramentas e tentativas de escrita dos reviewers falham por filesystem somente leitura. Marcadores públicos nos logs físicos retidos comprovaram três ciclos de escrita/leitura, quatro recusas de escrita em filesystem de reviewer somente leitura e sete recusas de capability token incorreto. O endpoint HTTP fixo anterior foi removido. A descrição oficial do executor está em [Self-hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted); a forma local e seu protocolo foram verificadas contra o `--help` e o ELF efetivamente executado. Não se usou registro remoto, credencial/API key, autenticação de provedor ou inferência real. O transporte HTTP de controle é exercitado por `Hono.request` com middleware real, sem benchmark de rede móvel.

A prova não é autorização operacional nem aceite dos 111 requisitos. O cancelamento do plano com worker ativo é prova separada do percurso positivo concluído, ambos na mesma bancada e com o mesmo contrato. O ramo ainda preserva incerteza conservadora; o teste não reivindica todas as intercalações de perda de ACK.

Validação do autor em 05/11/2026: typecheck normal sem `skipLibCheck` passou; bootstrap e contraprova da capacidade passaram **11/11, zero skips**. A execução completa da bancada passou **1/1, zero skips**, incluindo perda real de ACK após publicação, reconexão, SIGKILL e sucessor com pausa preservada. Evidências sanitizadas: `docs/validation/evidence/r3-flow-20261105.json`, `r3-flow-20261105.log`, `r3-flow-focused-20261105.log`, `r3-flow-types-20261105.log`. A execução final com exec-server real durou 60 segundos. Incluiu as contraprovas explícitas de workers ausentes, writers neutralizados e referência protegida inalterada após cancelamento. A medição local separada, sem homologação, observou oito admissões (um intent novo e sete retries idempotentes): p50 20,28 ms, p95/máximo 155,62 ms; autenticação p95 21,51 ms. Dez eventos comprometidos no PostgreSQL ficaram visíveis na API autenticada com limite superior conservador p50 115,37 ms, p95/máximo 200,61 ms, incluindo polling de 50 ms, consulta e autenticação. O transporte de controle usa chamada Hono no processo; a autenticação consulta Happier por HTTP real. Não mede inferência, rede móvel nem carga operacional.

Para uma instalação administrativa **já inicializada** e com arquivo privado próprio, os comandos existentes são `node --import tsx src/server-main.ts inspect /CAMINHO/installation.json` e `node --import tsx src/server-main.ts serve /CAMINHO/installation.json`. O arquivo deve declarar `mode: "administration-only"` e `nativeBootstrap: {"state":"disabled"}` (ou omitir o bootstrap). Servir não migra o banco nem ativa contas. O runner acima é a entrada separada e explícita da bancada executável; configurar o gateway administrativo não o converte em inferência operacional.

A revisão independente e a execução integrada pelo principal são registradas por seus autores; este documento não substitui esses pareceres.
