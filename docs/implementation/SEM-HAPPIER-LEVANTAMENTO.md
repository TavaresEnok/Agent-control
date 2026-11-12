# Sem Happier — levantamento (melhoria 4, passo 0)

Data: 12/11/2026. Só leitura do código neste worktree (`improve/happier-survey`). Nenhum código foi alterado. Não subi o gateway, não consultei o banco do IspAgent, não inspecionei o systemd do host e não usei a rede. Onde o código não responde, está escrito **não sei**.

O desenho recomendado está na seção 3 e nos passos da seção 6: **uma interface de transporte, duas implementações (`happier` e `local`), escolhida pela instalação**. O padrão continua `happier`. O modo `locked` e qualquer instalação pessoal ainda não migrada seguem no caminho atual.

Hoje o Happier faz as quatro coisas do pedido, e mais uma que o painel não substitui sozinho: o laço do gerente (`tick`) só anda com o socket ligado (`src/happier.ts:580`).

| Função | Onde a autoridade está hoje | O que já existe no gateway |
|---|---|---|
| Conversa cifrada (sessão, mensagens, fila `pending`) | Servidor Happier light, SQLite em `<dataDirectory>/happier/server.sqlite` (`scripts/personal-happier.mjs:12-22`) | `ac_chat_messages` é a caixa de saída cifrada, não a transcrição (`db/migrations/035_notification_batches.sql:1-2`, `src/notifications.ts:45-46`, `src/import.ts:122`) |
| Ponte do gerente (socket e `ack`) | `HappierEndpoint` (`src/happier.ts:237-248`, `:442-445`, `:748-774`) | `accept()` e `say()` já são métodos locais; o socket só entrega e confirma |
| Login, principal = conta Happier | `GET /v1/account/profile` (`src/server-main.ts:201-207`) | Senha e código já emitem o cookie (`src/server-main.ts:228-268`), mas o cookie guarda o Bearer do Happier e cada pedido o revalida |
| Notificações do app Happier | Texto canônico no Happier; o Postgres guarda metadado (`src/notifications.ts:45-46`) | Web Push do painel já é arquivo local + `web-push` (`src/personal-push.ts:9-37`, disparo em `src/happier.ts:511-518`) |

O painel já lê e escreve pela API do gateway: `GET /api/v1/ac/personal/conversation` e `POST /api/v1/ac/personal/messages` (`src/api.ts:256-271`). Esses handlers chamam o endpoint vivo (`src/managers.ts:222-233`), que hoje busca a página e enfileira no Happier (`src/happier.ts:779-804`).

## 1. Cada uso do Happier no modo pessoal

`activation` vale `locked` ou `personal` (`src/installation.ts:27`). O bloco `happier` é obrigatório nos dois (`src/installation.ts:44`). O modo pessoal liga conversa, execução e push quando o bootstrap está `active` (`src/server-main.ts:188-189`, `:214`, `:219`, `src/manager-transport.ts:38-41`).

### HTTP

| Chamada | Onde | Para que serve | Substituto no transporte local |
|---|---|---|---|
| `GET /v1/account/profile` espera 401 | `src/personal-connect.ts:47` | Saber se o servidor subiu | Não chamar. O `serve` não espera o Happier |
| `POST /v1/auth` | `src/personal-connect.ts:48-51` | Trocar a assinatura Ed25519 da semente pelo token | Não há conta remota. O principal sai do ledger (seção 4) |
| `GET /v1/account/profile` com Bearer | `src/personal-connect.ts:53-56`; de novo em `src/manager-transport.ts:31-34` e `src/happier.ts:308-314` | O `id` da conta vira `managerTransport.principal` e tem de bater com o token | O principal já gravado em `ac_session_links.principal_id` |
| `POST /v1/machines` | `src/personal-connect.ts:58-60`, `:121-123` | Registrar a máquina (`machineId`) com metadado cifrado | Não há máquina Happier. `machineId` deixa de ser usado pelo transporte local |
| `POST /v1/sessions` | `src/personal-connect.ts:62-65`, `:133-135` | Criar a sessão `e2ee` da conversa | `session_id` local (UUID) em `ac_session_links`, sem servidor. Na migração, o `session_id` que já existe permanece |
| `GET /v1/sessions/:id/messages` | `recoverHistory` (`src/happier.ts:104-135`) e `readPanelTranscript` (`src/happier.ts:140-208`); o CLI `say`/`chat-log` repete a leitura (`src/personal-connect.ts:181-190`) | Transcrição canônica, cursor `seq` | `SELECT` em `ac_personal_messages` por `context_id, seq` |
| `POST /v2/sessions/:id/pending` | `personalSay` (`src/personal-connect.ts:194-196`) e `enqueueOwnerMessage` (`src/happier.ts:793-800`) | Fila de entrada do titular | `INSERT` do dono com `accepted=false` |
| `POST /v2/sessions/:id/messages` | Fallback se a fila recusa 400/401/403/404 (`src/happier.ts:801-804`) | Cópia da fala do dono na transcrição | O `INSERT` já é a transcrição. Não há segundo POST |
| `GET /v2/sessions/:id` | `verifyHappierSession` (`src/sessions.ts:63-69`); `publishTeamModels` lê metadado e versão (`src/happier.ts:430-432`) | Provar que o Bearer enxerga a sessão `e2ee` e é o dono (`share=null`); ler `metadataVersion` | Posse pelo ledger: membership `owner` do projeto e `ac_session_links` do contexto. Metadado do seletor de modelo do app deixa de ser publicado |
| `POST /v1/auth/request` e `/claim` | `HappierAuthRelay.forward` (`src/auth-relay.ts:36-48`), rotas `src/api.ts:349-350` | Pareamento "Entrar pelo Happier" | No pessoal, essas rotas deixam de ser o login. No `locked`, o relay continua |

`personalSay` também decifra com `happier-account.key` (`src/personal-connect.ts:177-189`). O substituto do CLI é ler e gravar a tabela nova. Não sei se o titular ainda usa `say`/`chat-log` no IspAgent; o código do comando está em `src/server-main.ts:94-96`.

### Socket e `ack`

O construtor abre o websocket e registra o RPC `session.userMessage.send`, que chama `accept()` (`src/happier.ts:237-248`). Eventos: `rpc-request`, `connect`, `disconnect` (`src/happier.ts:274-276`). `ack()` é `socket.timeout(8000).emit` (`src/happier.ts:442-445`).

| Evento | Onde | Substituto local |
|---|---|---|
| `connect` / handlers RPC | `src/happier.ts:322-330` | `start()` do transporte local só valida o vínculo e arma o mesmo `setInterval` de 300 ms (`src/happier.ts:331`) |
| `session-alive` | `src/happier.ts:583`, `:587` | Nada. O lease continua no `heartbeat` (`src/happier.ts:582`) |
| snapshot de atividade (`SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT`) | `src/happier.ts:741-746` | Nada. Existia para o Happier liberar a fila |
| `materializeNextPendingQueueV2Message` + `resolveAcceptedPendingQueueV2Delivery` + `markPendingQueueV2DeliveryHandled` | `src/happier.ts:748-774` | `claim` / `settle` na tabela (seção 2) |
| `ack('message', …)` | `src/happier.ts:450-452` | A fala do gerente já está na tabela quando `say()` retorna. Não há recibo de publicação |
| `ack('update-metadata', …)` | `src/happier.ts:437` | Não publicar. Ver `teamModelsMetadata` abaixo |
| `tick` só se `socket.connected` | `src/happier.ts:580` | O laço local não consulta socket. Com o socket caído, hoje a execução, o progresso e o push param juntos |

O watchdog de 15 s existe porque o cliente Happier não reconecta sozinho (`src/manager-transport.ts:53-69`). Ele trata estado diferente de `running`/`starting` como queda (`src/managers.ts:182-190` usa `connectionState()`). O transporte local responde `connected` enquanto o intervalo estiver armado, para o watchdog não reiniciar à toa. Queda de processo continua sendo reinício: o lease vence em 15 s (`src/ledger.ts:60-68`).

### Chave da conta

`dataDirectory/happier-account.key` é um segredo de 32 bytes, criado uma vez (`src/personal-connect.ts:18-23`, `:94-95`). Ele é as duas coisas ao mesmo tempo:

- semente Ed25519 do login Happier (`src/personal-connect.ts:96-97`);
- chave `legacy` que cifra sessão, máquina, fila e transcrição (`src/personal-connect.ts:67-69`, `src/happier.ts:236`).

`personalConnect` grava a impressão em `ac_context_keys` e importa os mesmos bytes no cofre (`src/personal-connect.ts:142-151`). `app-key` imprime essa semente no formato "Restaurar com chave secreta" (`src/personal-connect.ts:209-219`, comando em `src/server-main.ts:89-92`).

`validateLink` continua exigindo essa chave a cada efeito (`src/happier.ts:278-289`, `src/managers.ts:52-60`). O transporte local pode manter a chave que já está no cofre: ela ainda autentica o contexto. Ela deixa de sair do host e deixa de cifrar a conversa nova. Instalação nova, sem Happier, gera 32 bytes só para o cofre do contexto. Não sei o valor da chave do IspAgent; não abri o diretório de dados.

Quem ainda decifra `ac_chat_messages` com essa chave, e precisa passar a ler a tabela nova no mesmo passo em que a caixa de saída deixar de ser escrita:

- a fonte do pedido nativo (`src/happier.ts:297-300`);
- a proposta semântica (`src/happier.ts:459-463`);
- o texto original no replanejamento (`src/happier.ts:547-548`).

### Token da máquina (`manager-token`)

`personalConnect` grava o Bearer em `managerTransport.tokenFile` (`src/personal-connect.ts:99-100`, `:156`). O schema exige `tokenFile` e `machineId` (`src/installation.ts:40-42`). `startConfiguredManagerTransport` lê o arquivo, recusa token com espaço e confere o `id` no Happier (`src/manager-transport.ts:26-34`). Senha e código releem o mesmo arquivo e chamam `verify` (`src/server-main.ts:232-237`, `:254-259`).

Substituto: o transporte `local` não lê esse arquivo. O campo pode permanecer no JSON durante a transição, ignorado, porque o objeto é `.strict()` e um arquivo antigo sem os campos novos precisa continuar válido. Apagar o arquivo só depois do corte, com o Happier ainda no disco para voltar atrás.

### `personal-connect`

`src/personal-connect.ts:83-166`. Só com `activation==='personal'` (`:91`). Exige o upstream em loopback (`:25-28`, `:92`). Se o perfil mudou, descarta os contextos antigos do JSON (`:103-104`). Para cada projeto sem conversa: políticas, máquina (uma por conta), sessão, membership `owner` com o **id Happier** (`:136`), contexto, chave, template, cofre e reescrita de `managerTransport` (`:156`).

Substituto: um `personal-connect` local que faz o mesmo ledger (políticas, contexto, cofre, template) com `principal = config.project.owner` quando o projeto ainda não tem conversa, e com o `principal_id` já ligado quando a conversa existe. Não chama `livePersonalHappier()`. O comando `src/server-main.ts:85-87` permanece; o ramo depende do transporte da instalação.

`personal-project` e `--share-happier` copiam a chave e apontam `happier-shared-from` para a instalação dona (`scripts/personal-project.mjs:52-67`). O gateway dessa outra instalação espera o serviço Happier da dona (`scripts/personal-services.mjs:37-42`). Não sei se alguma instalação aponta para o Happier do IspAgent.

### `personal-happier`

`scripts/personal-happier.mjs:1-26` sobe o servidor light não modificado, SQLite, porta de `happier.upstreamOrigin`, host `127.0.0.1`. Com `happier-public-url`, fecha o cadastro anônimo. O systemd do usuário é `agent-control-happier-<nome>.service` (`scripts/personal-services.mjs:11-15`, `:41-43`). O nome é o argumento ou o diretório do arquivo de instalação. Para o diretório `ispagent`, o unit é `agent-control-happier-ispagent.service`. Não sei se esse unit está habilitado agora.

`personal:public` reinicia esse unit e exige que `https://<domínio>/v1/account/profile` responda 401 (`scripts/personal-public.mjs:62-73`). `personal:cockpit`, no mesmo nome, manda `/v1` `/v2` `/v3` `/health` `/ready` `/.well-known` para o Happier (`scripts/personal-cockpit.mjs:2-9`, `:45-50`).

Substituto: não instalar e não subir esse processo. O unit do gateway deixa de ter `After=`/`Wants=` nesse serviço. O site público deixa de precisar das rotas `/v1` do Happier. Isso é passo de corte, não dos passos anteriores (seção 6).

### `verify` do `server-main`

`src/server-main.ts:201-207`. Qualquer `Authorization: Bearer` é enviado ao Happier; o `id` do perfil é o principal. O gateway usa isso no cookie e no Bearer direto (`src/server-main.ts:280-284`, `src/api.ts:150-157`). `BrowserSessions.authenticate` decifra o Bearer guardado no cookie e chama o mesmo `verify` (`src/sessions.ts:36-50`). Com o Happier parado, a sessão do painel morre mesmo com o cookie válido.

Substituto no pessoal: o cookie identifica o principal do ledger e a sessão não volta ao Happier. O Bearer de conta Happier deixa de autenticar o painel pessoal. O `verify` atual permanece no processo quando o transporte da instalação é `happier` (modo `locked` e pessoal ainda não migrado).

Antes de carregar o cliente embutido, o `serve` fixa `HAPPIER_SERVER_URL` no upstream da instalação para o default público não vazar (`src/server-main.ts:132-134`). O transporte local não deve chamar `loadHappier()` (`src/happier.ts:59-67`). Enquanto qualquer outro ramo do mesmo processo puder carregar o boundary, o pin fica.

### `BrowserSessions`

Cookie opaco `ac_session`; o Bearer fica cifrado no Postgres (`src/sessions.ts:5-34`, tabela `db/migrations/022_browser_sessions.sql:1`). `issue` exige Bearer e o grava (`src/sessions.ts:22-34`). Senha e código fabricam esse Bearer com o `manager-token` (`src/server-main.ts:246-247`, `:266-267`).

Substituto: no pessoal, emitir o cookie com o principal do ledger, sem coluna de Bearer Happier. `authenticate` devolve esse principal se o cookie não estiver revogado nem vencido, e o pedido seguinte continua checando membership no ledger (`src/api.ts:258`, `:267`). `issue()` atual fica para o pareamento, usado quando o relay existe.

`verifyHappierSession` (`src/sessions.ts:52-70`) é o que o `serve` passa como acesso à sessão (`src/server-main.ts:223-224`, `:276`). Serve para ligar uma sessão Happier já existente a um contexto (`src/api.ts:413-416`). No pessoal a conversa nasce no `personal-connect`, não nessa rota. Substituto pessoal: não consultar o Happier; a rota de vínculo de sessão Happier continua disponível no transporte `happier`.

### `HappierAuthRelay`

`src/auth-relay.ts:27-49`. O `serve` sempre constrói o relay (`src/server-main.ts:225`). A configuração pública sai em `GET /api/v1/ac/auth/config` (`src/api.ts:142-145`): `enabled`, `webUrl`, `serverUrl`. O botão "Entrar pelo Happier" só corre se `enabled===true` (`upstream/cezar/packages/web/src/components/auth/agent-control-auth-gate.tsx:38-39`, `:117`, `:125`). O pareamento decifra no navegador e só então chama `POST /api/v1/ac/auth/session` com o Bearer (`:49-64`).

Substituto no pessoal: `auth/config` com `enabled:false` e `passwordLogin:true`. A tela que já existe é usuário, senha e "Entrar com código" (`:109-115`). O relay não é montado nesse modo. No `locked`, o relay continua.

### Notificações

Há dois canais:

1. **Texto na conversa Happier.** `Notifications.observe` grava cursor e item (`src/notifications.ts:55-78`). `flush` cifra o texto em `ac_chat_messages` (`:80-104`). `deliver` manda o ciphertext pelo socket e só marca `sent` com o ACK `{ok, id, seq, localId}` (`:106-131`, recibo imutável em `db/migrations/035_notification_batches.sql:36-47`). O `tick` chama os dois (`src/happier.ts:735`). `say()` e a proposta também entram nessa caixa (`src/happier.ts:418-424`, `:506-508`) e só aparecem no painel depois que o Happier as devolve.
2. **Web Push do telefone.** `notePersonalPush` (`src/happier.ts:511-518`) chama `deliverPersonalPush` com título, corpo e URL do painel. Não usa socket nem token Happier. Permanece.

Substituto do canal 1: `flush` e `say()` gravam a linha `role=manager` na tabela nova e marcam o item de notificação como publicado sem ACK Happier. O `message_id` de `ac_notification_items` referencia `ac_chat_messages` (`db/migrations/035_notification_batches.sql:29`). Um transporte local não pode enfiar o id novo nessa coluna. O passo que desliga o `deliver` acrescenta uma coluna anulável (por exemplo `local_message_id`) e trata "já publicado" como `message_id` ou `local_message_id` preenchido. Enquanto os dois forem nulos, o comportamento Happier fica igual. Não sei se o IspAgent tem itens com `message_id` nulo agora.

### `teamModelsMetadata`

`src/personal-team-feed.ts:110-122` monta `sessionModelsV1` para o seletor de modelos do **app Happier**, que numa sessão com sabor Claude listaria o catálogo da Claude. `publishTeamModels` lê `GET /v2/sessions/:id`, cifra e faz `ack('update-metadata')` com `expectedVersion` (`src/happier.ts:426-440`), no máximo uma vez por processo, a cada 60 s (`src/happier.ts:690-692`).

O painel não lê esse metadado. "Equipe" na conversa usa `teamStatus` (`src/personal-team-feed.ts:98-107`, chamado em `src/happier.ts:362`). O relato de etapa usa `registerStageReporter` (`src/personal-team-feed.ts:127-135`, `src/server-main.ts:193`).

Substituto: o transporte local não chama `publishTeamModels`. A função fica na implementação Happier. Nenhuma tela nova.

## 2. Onde a conversa deve morar

### Por que não `ac_chat_messages`

A tabela (`db/migrations/002_chat_and_plans.sql:1-3`, `db/migrations/003_chat_order.sql:1`, `db/migrations/035_notification_batches.sql:34-35`) é:

- `id` texto, na prática `sessionId|localId` (`src/happier.ts:409`);
- `session_id` obrigatório, chave estrangeira para `ac_session_links`;
- `ciphertext` obrigatório, cifrado com a chave da conta Happier (`src/happier.ts:236`, `:407`);
- `sent`, preenchido só depois do ACK Happier (`src/notifications.ts:128`);
- `priority` 0, 50 ou 100, ordem de entrega, não ordem de leitura;
- `sequence` identidade da caixa de saída.

O painel não lê essa tabela. Lê o Happier, e o cursor `after` é o `seq` numérico de lá (`src/personal-panel-conversation.ts:7-16`, `src/happier.ts:186`). `recoverHistory` devolve o texto decifrado só para a memória (`src/happier.ts:318`, `:230`) e `close()` zera (`src/happier.ts:806`). Não há gravação dessa recuperação no Postgres.

Reusar a tabela misturaria transcrição com caixa de saída, exigiria o ACK Happier para `sent=true` e quebraria o modo que ainda publica no Happier. A frase do próprio código: o ciphertext da importação era caixa de saída temporária e o Happier segue como autoridade da transcrição (`src/import.ts:122`).

### Tabela nova

Uma migração aditiva, sem alterar `ac_chat_messages`:

```sql
CREATE TABLE ac_personal_messages (
  id text PRIMARY KEY,
  context_id uuid NOT NULL REFERENCES ac_contexts(id),
  role text NOT NULL CHECK (role IN ('owner','manager')),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  local_id text NOT NULL,
  accepted boolean NOT NULL DEFAULT false,
  UNIQUE (context_id, local_id)
);
```

`id`, `context_id`, `role`, `text`, `created_at` e `seq` são o desenho pedido. `local_id` e `accepted` entram porque `accept()` é idempotente em `contextId` + `localId` (`src/happier.ts:376`) e a fila precisa de um estado "ainda não aceitei". O `seq` continua cabendo no cursor do painel (`^[0-9]{1,15}$`). `created_at` vira o `createdAt` ISO que `panelMessageFromRecord` já devolve (`src/personal-panel-conversation.ts:46-55`).

Índice de leitura: `(context_id, seq)`. Índice da fila: `(context_id, seq) WHERE role='owner' AND NOT accepted`.

Uma instalação com vários projetos tem um contexto por projeto (`src/personal-connect.ts:130-153`). A linha guarda `context_id`, não um único `session_id` global.

### A cifra é necessária?

Não, para a conversa nova no banco da própria instalação. A cifra de hoje é a E2EE do Happier (variante `legacy`, chave da conta), porque o servidor Happier é quem guarda a transcrição (`scripts/personal-happier.mjs:22` pede `required_e2ee`). O gateway já decifra tudo e já grava em claro plano, intenção, auditoria e recibo de job. O texto da conversa é a exceção: em `ac_intents` entra o digest, não a frase (`src/happier.ts:396-401`).

Texto em claro em `ac_personal_messages` fica no mesmo limite de confiança do resto do ledger. O painel já devolve esse texto a quem tem o cookie (`src/api.ts:262`).

Resíduo, de propósito: hoje um dump só do Postgres não contém a conversa legível; o ciphertext de `ac_chat_messages` não abre sem `happier-account.key`, que está no diretório de dados. Depois da troca, o dump passa a ter o texto. O backup pessoal já copia a chave e o SQLite do Happier (`src/personal-backup.ts` cita os dois em `docs` gerado; o teste espera `data/happier-account.key` e `data/happier/server.sqlite` em `tests/personal-backup.test.ts:95` e `:103`). Não cifrei a proposta com a chave do cofre: a coluna pedida é `text`, e a chave do cofre continua só para `validateLink` e para decifrar o histórico na importação.

### Fila de entrada

Hoje o `pending` do Happier é a fila (`POST /v2/sessions/:id/pending`). O `tick` pega uma mensagem quando o runtime está ocioso (`src/happier.ts:748-752`), chama `accept()` via RPC (`:756-757`) e só então confirma a entrega (`:773-774`). Recusa definitiva no modo pessoal explica e fecha a entrega (`:759-770`). Recusa transitória (`STALE_MANAGER`, capacidade, admissão, pausa, reinício) deixa a entrega reivindicada (`:763-764`).

Substituto:

- o painel e o CLI inserem `role=owner`, `accepted=false`, `local_id` estável (`panel-<clientId>`, `src/personal-panel-conversation.ts:25-27`);
- o laço faz `SELECT … WHERE role='owner' AND NOT accepted ORDER BY seq LIMIT 1 FOR UPDATE`;
- chama o mesmo `accept()`;
- recusa definitiva: `accepted=true` e uma linha `manager` com o mesmo texto de recusa (`src/happier.ts:766`);
- recusa transitória: deixa `accepted=false` para o próximo tick;
- sucesso: `accepted=true`. O `accept()` segue gravando a intenção. A linha do dono na tabela nova é a fala visível; a gravação cifrada em `ac_chat_messages` (`src/happier.ts:408-410`) fica só na implementação Happier.

`say()` (`src/happier.ts:506-509`) passa a inserir `role=manager`, `accepted=true`, no mesmo ponto em que hoje grava a caixa de saída, e em seguida o Web Push como já faz.

## 3. A ponte sem socket

Interface única. `HappierEndpoint` continua dono de `accept`, `tick`, proposta, parar, aprovar, equipe e replanejamento. O que muda é por onde a mensagem entra e sai.

```ts
interface ManagerTransport {
  kind: 'happier' | 'local';
  start(): Promise<void>;
  connectionState(): 'connected' | 'disconnected';
  claimOwnerMessage(): Promise<{text: string; localId: string; meta?: unknown} | null>;
  settleOwnerMessage(localId: string, outcome: 'accepted' | 'refused'): Promise<void>;
  publishManagerText(localId: string, text: string, record: unknown): Promise<{id: string; seq: number}>;
  readPage(after: string | undefined, limit: number): Promise<PanelPage>;
  publishTeamModels(): Promise<void>;
  close(): void;
}
```

| Método | Implementação Happier (o código de hoje) | Implementação local |
|---|---|---|
| `start` | Perfil, `recoverHistory`, `transport.connect`, handlers (`src/happier.ts:303-330`) | `validateLink` e o intervalo. Sem `loadHappier()`, sem perfil, sem socket |
| `connectionState` | `socket.connected` (`src/happier.ts:778`) | `connected` enquanto o intervalo existe |
| `claimOwnerMessage` | `receivePending` (`src/happier.ts:740-776`) | A linha `owner` não aceita |
| `settleOwnerMessage` | `resolveAccepted…` + `markPending…` (`:767-774`) | `accepted=true` |
| `publishManagerText` | `insertAgentMessage` + `deliver` via `ack('message')` (`src/happier.ts:418-424`, `:450-452`) | `INSERT` do gerente. Sem ciphertext e sem ACK |
| `readPage` | `readPanelTranscript` (`src/happier.ts:779-783`) | Página por `seq` |
| `publishTeamModels` | `src/happier.ts:428-440` | Resolve na hora |
| `close` | Aborta, limpa o timer, desconecta (`src/happier.ts:806`) | Aborta e limpa o timer |

O `tick` deixa de começar com `if (!this.socket.connected) return` (`src/happier.ts:580`). Na implementação Happier, essa condição vira "transporte desconectado". O `session-alive` e o snapshot de runtime ficam dentro da implementação Happier, antes do `claim`.

### `ManagerRegistry`

Já é agnóstico: a fábrica devolve `ManagedEndpoint` com `start`, `close`, `connectionState`, `readPanelConversation`, `enqueueOwnerMessage` (`src/managers.ts:25-29`). `readPanelConversation` e `enqueuePanelMessage` só delegam (`src/managers.ts:222-233`). Não precisam saber o transporte.

Quem escolhe é `startConfiguredManagerTransport` (`src/manager-transport.ts:19-41`). Hoje ele sempre lê o token, chama o perfil e usa `happierEndpointFactory` (`src/managers.ts:258-262`). Passa a olhar um campo novo, opcional, default `happier`:

- `happier`: o bloco atual, inclusive o `fetch` do perfil e o watchdog;
- `local`: não lê `tokenFile`, não chama o upstream, fábrica local, mesmo cofre e o mesmo `startFromKeySource` (`src/managers.ts:92-111`). O watchdog pode ficar; com `connectionState()==='connected'` ele não reinicia em ciclo.

`HappierEndpoint` deixa de chamar `fetch`, `socket` e `boundary.materialize…` direto. Essas chamadas descem para a implementação Happier da interface. O modo `locked` usa essa implementação enquanto o default for `happier`.

O schema é `.strict()` (`src/installation.ts:46`). O campo entra opcional em `managerTransport`, por exemplo `transport: 'happier' | 'local'`, default `'happier'`. `happier`, `tokenFile` e `machineId` continuam obrigatórios neste passo, para o JSON do IspAgent e o do modo `locked` abrirem sem edição. O transporte local ignora token e máquina. Tornar o bloco `happier` opcional fica para depois do corte; fazê-lo opcional agora permitiria um `locked` sem upstream subir e quebrar no `verify`.

`personalConversation: personal?.transportOnly===false` (`src/manager-transport.ts:41`) continua sendo o que liga proposta, equipe e push. É independente do transporte.

Canal da intenção: `ac_deliveries.channel` só aceita `happier`, `cockpit`, `api`, `mcp`, `automation` (`db/migrations/001_authority.sql:20`). `accept()` grava `'happier'` (`src/happier.ts:408`). Nos primeiros passos o transporte local continua gravando `'happier'`, para não migrar o `CHECK` junto com o corte. Alargar o `CHECK` é um passo posterior, separado. Não sei quantas linhas reais usam esse canal no IspAgent.

## 4. Login

O dono registrado na instalação é `config.project.owner` (`src/installation.ts:25`, gravado em `src/projects.ts:29` por `initializeInstallation`, `src/installation.ts:109-113`). O `personal-connect` acrescenta **outro** owner: o `id` da conta Happier (`src/personal-connect.ts:98`, `:136`). A conversa fica ligada a esse id (`ac_session_links.principal_id`, `src/ledger.ts:56`, conferido em `src/happier.ts:287-288`).

Não sei se, no IspAgent, `config.project.owner` e o `principal` do `managerTransport` são o mesmo texto. Se não forem, trocar o cookie para `config.project.owner` quebra `SESSION_CONTEXT_MISMATCH` e a posse do contexto. O principal da sessão pessoal passa a ser o `principal_id` já gravado em `ac_session_links` da conversa do projeto principal: esse valor já é owner no ledger (`src/personal-connect.ts:136`). Não é um id buscado no Happier a cada pedido. Instalação nova, sem conta Happier, usa `config.project.owner` desde o `personal-connect` local.

Senha e código já existem de ponta a ponta:

- gravação da senha: comando `password` (`src/server-main.ts:70-83`, `src/personal-password.ts`);
- `POST /api/v1/ac/auth/password` e `/auth/code` (`src/api.ts:355-361`);
- formulário (`agent-control-auth-gate.tsx:73-99`, `:109-123`).

Os dois ainda exigem `managerTransport`, leem o token e recusam se o Happier não confirmar o owner (`src/server-main.ts:231-240`, `:253-261`). O substituto confere a senha ou o código como hoje e emite o cookie para o principal do ledger, sem `readPrivateFile` do token e sem `verify`.

O que sai do modo pessoal, no passo de login, não antes:

- o botão "Entrar pelo Happier" e o link "Autorizar no aplicativo Happier" (`agent-control-auth-gate.tsx:117`, `:125-128`);
- o texto "Sua conversa continua no Happier" (`:106`), quando a senha está ligada;
- `HappierAuthRelay` e as rotas `/api/v1/ac/auth/pair` e `/pair/claim` nesse modo (`src/api.ts:349-350`);
- `verify` por Bearer contra `/v1/account/profile` para o painel pessoal (`src/server-main.ts:201-207`);
- o arquivo `manager-token` como credencial de sessão (`src/personal-connect.ts:99-100`).

`POST /api/v1/ac/auth/session` (`src/api.ts:351-353`) existe para o navegador entregar o Bearer do pareamento. No pessoal ele deixa de ser necessário. A rota pode continuar no transporte `happier`.

Efeito colateral: hoje um token Happier inválido derruba o cookie no próximo `authenticate` (`src/sessions.ts:47-50`). Depois, a sessão dura até o `Max-Age`, o logout (`src/sessions.ts:72-75`) ou a troca da senha. Não há mais revogação remota. Não sei se o titular depende dessa revogação.

## 5. Migração do IspAgent

Não li `~/.agent-control/ispagent`, o SQLite nem o journal. Os comandos abaixo são o procedimento recomendado, não um estado que eu tenha observado. O unit, se o nome foi o diretório, é `agent-control-happier-ispagent.service` (`scripts/personal-services.mjs:11-15`). O gateway é `agent-control-gateway-ispagent.service` (`:15`, `:42`). O guia já usa esse nome de instalação (`docs/USO-PESSOAL.md:50`, `docs/PLANO-PAINEL-E-PROJETOS.md:53`).

Importar o histórico, com o Happier ainda no ar e o transporte ainda `happier`:

1. Backup da instalação (o fluxo já descrito em `src/personal-backup.ts`; inclui a chave e o SQLite).
2. Um comando novo, só no modo pessoal, que para cada contexto de `managerTransport.contexts` carrega a chave do cofre e percorre `recoverHistory` (`src/happier.ts:104-135`) ou páginas de `readPanelTranscript` (`src/happier.ts:140-208`).
3. Cada mensagem visível (`panelMessageFromRecord`, `src/personal-panel-conversation.ts:45-55`) vira uma linha. `local_id` estável = id da mensagem no Happier. `accepted=true` (já entrou na conversa). `ON CONFLICT (context_id, local_id) DO NOTHING`.
4. A importação não chama `accept()` de novo: isso abriria intenção duplicada. É só transcrição.
5. Prova: o número de linhas visíveis igual ao número de registros que `readPanelTranscript` devolveu, e um trecho conhecido do IspAgent aparece no `GET /api/v1/ac/personal/conversation` **ainda servido pelo Happier**, mais a contagem na tabela. Não sei o tamanho da conversa; `recoverHistory` recusa acima de 100 páginas de 150 (`src/happier.ts:109`, `:135`). Se o IspAgent passou disso, a importação tem de paginar por `readPanelTranscript` até `hasMore` falso, não por um único `recoverHistory`. Não sei se passou.

Trocar a instalação, num segundo momento, com o histórico já importado e conferido:

1. Gravar `managerTransport.transport = "local"` no JSON. Não apagar `happier`, `tokenFile`, `machineId`, a chave nem o SQLite.
2. Reiniciar só `agent-control-gateway-ispagent`. O unit do Happier continua de pé, sem tráfego novo do gateway.
3. Um pedido curto pelo painel: a linha do dono entra na tabela, o `accept()` roda, a resposta do gerente aparece no `GET` da conversa. O Happier não precisa responder.
4. Aí sim, `systemctl --user disable --now agent-control-happier-ispagent`. Não usar `personal:services --remove`: esse caminho também desliga o gateway (`scripts/personal-services.mjs:16-19`).
5. Se outro projeto tem `happier-shared-from` para esta instalação, o passo 4 derruba a conversa dele. Não sei se existe. Conferir esse arquivo nas outras instalações antes de desligar.

Volta atrás, enquanto o SQLite e a chave não forem apagados:

1. `managerTransport.transport = "happier"` (ou retirar a chave, já que o default é `happier`).
2. `systemctl --user enable --now agent-control-happier-ispagent`.
3. Reiniciar o gateway.

O histórico antigo continua no SQLite. Mensagens gravadas só na tabela nova, no intervalo em que o transporte foi `local`, não reaparecem no Happier sozinhas. Voltar atrás nesse intervalo exige reexportar essas linhas para o `pending` ou aceitar o buraco. Por isso o corte só acontece depois de um pedido de prova, e o rollback combinado é "ainda não houve conversa nova" ou "reexportar as linhas com `seq` maior que o corte". Não implementei o reexport; o caminho de ida já existe (`POST /pending`, `src/happier.ts:793-800`).

O Caddy de `personal:public` deixa de receber 401 em `/v1` quando o Happier para (`scripts/personal-public.mjs:70-73`). Isso não é falha do painel. Não regenerei o site. Não sei o domínio em uso além do que o relatório antigo cita; não consultei o host.

## 6. Passos pequenos

Cada passo deixa o IspAgent no transporte `happier` até o passo 8. Prova mínima não inclui a suíte inteira.

| Passo | Arquivos | Risco | Prova mínima | IspAgent |
|---|---|---|---|---|
| 1. Tabela `ac_personal_messages` e coluna anulável `local_message_id` em `ac_notification_items`. Nada lê ainda | `db/migrations/` nova | Baixo. Migração aditiva. O `WHERE message_id IS NULL` do flush (`src/notifications.ts:71`, `:83`) continua igual se a coluna nova não entrar nesse predicado ainda | Migração sobe num banco vazio de teste; uma instalação antiga abre | Gateway atual nem vê a tabela. Segue no Happier |
| 2. Extrair a interface e mover as chamadas atuais para a implementação `happier`, default | `src/happier.ts`, `src/managers.ts` (fábrica), `src/manager-transport.ts` | Médio: o `tick` e o `deliver` são o mesmo código, só o endereço das chamadas muda. Um `return` cedo no socket (`:580`) tem de continuar no ramo Happier | Os testes que já sobem `HappierEndpoint` (`tests/happier.test.ts`, `tests/notifications.test.ts`) passam sem mudar o comportamento esperado | Sem troca de configuração. Reiniciar o gateway neste passo é o mesmo cliente Happier |
| 3. Implementação `local` atrás do campo, default `happier`. `say` grava a tabela; o laço chama `accept` | `src/happier.ts` ou módulo novo ao lado, `src/installation.ts` (campo opcional) | Médio, contido no ramo novo. O schema `.strict()` rejeita campo desconhecido: o campo tem de nascer opcional com default | Teste com ledger falso: inserir fala do dono, ver a intenção, ver a fala do gerente na tabela, ler a página. Nenhum `fetch` para o Happier nesse teste | Campo ausente. O ramo local não roda |
| 4. Espelho, ainda no transporte `happier`: cada fala visível que `say`/`accept`/flush grava também entra em `ac_personal_messages` | Os mesmos pontos de insert (`src/happier.ts:408-410`, `:418`, `:506`) | Baixo se a falha do espelho não falha a conversa Happier. Duplicar `local_id` é `DO NOTHING` | Um teste de painel existente continua lendo o Happier; a tabela ganha a mesma fala | Ligar o espelho só depois do backup. O painel segue lendo o Happier |
| 5. Comando de importação (`recoverHistory` / `readPanelTranscript`) | Comando novo ao lado de `personal-connect`, `src/server-main.ts` no mesmo estilo de `say` | Médio: chave e token saem do cofre e do arquivo, como o `serve` já faz. Não grava intenção | Contagem conferida contra o Happier num fixture. No IspAgent, contagem e uma frase conhecida, com o serviço ainda no ar | Continua no Happier durante e depois |
| 6. Leitores nativos: se a linha nova existe, o texto vem dela; senão, do ciphertext | `src/happier.ts:297-300`, `:459-463`, `:547-548` | Médio. Digest do texto tem de bater com `messageDigest` (`:300`) | Teste que já cobre a fonte nativa, mais um caso com a linha nova e sem ciphertext | Ainda escreve os dois. Os dois caminhos lêem o mesmo texto |
| 7. Login pessoal sem Bearer | `src/server-main.ts:228-268`, `src/sessions.ts` (emissão por principal, sem mexer em `issue` do pareamento), `agent-control-auth-gate.tsx` só quando `enabled===false` | Alto se o `verify` global mudar. O `verify` do transporte `happier` fica intacto. Cookie antigo, emitido com Bearer, continua sendo aceito pelo `authenticate` atual até expirar | Teste: senha emite cookie com o Happier derrubado no fake; um teste de pareamento `locked`/relay continua chamando o upstream (`tests/auth-origins.test.ts`, `tests/session-link.test.ts`) | Pode entrar por senha ainda dependente do Happier até este passo ser ligado. Não desligar o Happier aqui |
| 8. Corte do IspAgent | JSON da instalação (fora do git), systemd, não o Caddy ainda | Alto, operacional. Mensagens novas deixam de ir para o SQLite | Backup, importação conferida, `transport=local`, reinício só do gateway, um pedido real curto, conversa visível no painel, então `disable --now` do unit Happier | Este é o único passo em que o IspAgent larga o Happier. O passo 9 volta atrás |
| 9. Documentar e, se o corte segurou, parar de exigir o processo na operação pessoal | `docs/USO-PESSOAL.md`, `scripts/personal-services.mjs` (`After=`/`Wants=`), `scripts/personal-cockpit.mjs` | Médio na publicação. Não apagar `upstream/happier` nem o ramo `happier` do código | `personal:services` numa instalação `local` sobe só o gateway; uma instalação sem o campo continua subindo os dois | Já no transporte local. O unit Happier permanece no disco, desligado, até o titular apagar |

Fora desta lista, de propósito: apagar `happier-account.key`, o SQLite, o bloco `happier` do schema e o código do endpoint. Isso elimina a volta atrás.

## 7. Riscos para o modo `locked`

`locked` é o default (`src/installation.ts:27`). Ele continua com `managerTransport` opcional, upstream Happier obrigatório e `verify` por Bearer. Bootstrap `active` com ativação diferente de `personal` já é recusado (`src/server-main.ts:188`). O transporte do `locked`, quando existe, sobe com `transportOnly: prepared.report.state!=='active'` (`src/server-main.ts:219`), isto é, sem conversa pessoal, sem push e sem `publishTeamModels`.

Riscos se a extração for descuidada:

- Mudar `HappierEndpoint` ou o default da fábrica quebra o `locked` e os testes que constroem o endpoint direto (`tests/happier.test.ts`, `src/lab-main.ts:49-54`). O default tem de ser a implementação que preserva socket, fila, ACK e `ac_chat_messages`.
- `serve` sempre cria `BrowserSessions` com `verify` do Happier e sempre cria o relay (`src/server-main.ts:201-225`). Condicionar isso a `activation==='personal'` sem olhar o transporte derruba o login do cockpit bloqueado ("Entrar pelo Happier", `agent-control-auth-gate.tsx:117`).
- Tornar o bloco `happier` opcional no schema deixa um arquivo `locked` passar do parse e falhar no `fetch` (`src/manager-transport.ts:31`). O bloco segue obrigatório.
- Alargar o `CHECK` de `ac_deliveries.channel` não é necessário para o corte e mexe num invariante do ledger (`db/migrations/001_authority.sql:20`). Adiar.
- `assertManagerTransportAllowed` só recusa o estado `bench` (`src/native-bootstrap.ts:184-186`). O transporte local não deve alargar isso: um `locked` com `transport=local` não tem conversa pessoal e não deve ganhar execução. Recusar `local` quando `activation!=='personal'`.
- O pin `HAPPIER_SERVER_URL` (`src/server-main.ts:132-134`) protege o processo inteiro. Tirá-lo porque o pessoal não usa Happier reabre o default público para o ramo `locked` do mesmo binário.
- `ac_chat_messages`, recibos e `Notifications.deliver` são o caminho de status do modo que ainda publica no Happier (`src/notifications.ts:106-131`). O ramo local não escreve nessa tabela; o ramo Happier não deixa de escrever.
- Testes de recuperação de laboratório guardam snapshot do Happier (`src/laboratory-recovery.ts:61-64`). Não entram nesta mudança.

Não sei se existe instalação `locked` com `managerTransport` preenchido em uso real. O código permite.

## O que não sei

- Se o unit `agent-control-happier-ispagent` está ativo, e se o nome do diretório da instalação é `ispagent`.
- Se `config.project.owner` e o `principal` Happier do IspAgent são o mesmo texto.
- O tamanho da conversa (se passa de 100 páginas de 150) e se há mensagens no Happier que o gateway nunca copiou para `ac_chat_messages`. A autoridade para importar é o Happier, não a caixa de saída.
- Se alguma outra instalação usa `--share-happier` apontando para o IspAgent.
- Se há itens de notificação ainda sem `message_id`.
- O domínio e o Caddy em uso neste momento.
- Se o titular ainda entra pelo app Happier, pelo `say` do terminal, ou só pelo painel.
