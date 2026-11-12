# Uso pessoal

Um titular, no servidor, pelo Happier. Sem este opt-in o sistema continua bloqueado.

## Ligar um repositório em um comando

Com as imagens dos workers já construídas (seção "Imagens dos workers") e um banco PostgreSQL vazio só para este projeto:

```bash
npm run personal:project -- /caminho/do/repositorio --db postgresql://usuario:senha@127.0.0.1:5432/banco --label meuprojeto --import-logins
```

O comando cria `~/.agent-control/<label>/installation.json` (fora do repositório, modo `0600`), inicializa o ledger, registra as contas, ativa o runtime nativo e cria a conversa. `--import-logins` copia, sem mover, os logins que já existem no seu usuário (`~/.claude/.credentials.json`, `~/.grok/auth.json`, `~/.codex/auth.json`). Sem essa opção ele para e mostra os comandos `account-add` para um login novo por código; depois rode o mesmo comando de novo. Pode ser repetido sem duplicar nada.

Depois, deixe os dois serviços permanentes (systemd do usuário; voltam depois de um reboot se `loginctl enable-linger $USER` estiver ativo):

```bash
npm run personal:services -- ~/.agent-control/meuprojeto/installation.json meuprojeto
```

Para remover: o mesmo comando com `--remove`. Os passos abaixo são o caminho manual, peça por peça.

### Mais um projeto no mesmo app

Para o outro repositório aparecer como mais uma conversa no app que você já usa (mesmo banco, mesmos logins, mesma conta Happier, mesmo token e a mesma máquina):

```bash
npm run personal:project -- --add ~/.agent-control/ispagent/installation.json /caminho/do/outro --label outro
```

O comando acrescenta o projeto em `projects[]` com um id novo e o caminho absoluto do repositório, registra o projeto, o dono e o repositório no banco que já existe, dá acesso às contas desse dono e publica a primeira política de capacidade e a de qualidade. Em seguida abre a conversa na mesma conta. O título da sessão no app é o nome passado em `--label`.

Antes de reescrever `installation.json`, o comando confere se `nativeBootstrap` aceita o repositório em `projects[]`. O arquivo anterior fica ao lado, em `installation.json.before-add-<label>`. Rodar de novo não duplica.

O comando recusa um caminho que não é Git ou não tem branch, um repositório que já está nesta instalação, um caminho dentro do diretório de dados e um repositório que pertence a outra instalação.

No fim ele pede o reinício do gateway que já está no ar. O nome do serviço é o diretório da instalação (o `basename` de `dataDirectory`), o mesmo critério de `personal:services`:

```bash
systemctl --user restart agent-control-gateway-<nome>
```

O app não abre projeto novo sozinho: "nova sessão" numa pasta pede um daemon do Happier na máquina, e o Agent Control não roda um. Por isso a máquina "agent-control" aparece offline. As conversas dos projetos ligados aqui funcionam mesmo assim.

### Pastas que o painel pode abrir

O painel só lista pastas dentro das raízes gravadas em `projectRoots`. Nada fora delas aparece.

```bash
npm run personal:roots -- ~/.agent-control/ispagent/installation.json list
npm run personal:roots -- ~/.agent-control/ispagent/installation.json add /caminho/da/pasta --label projetos
npm run personal:roots -- ~/.agent-control/ispagent/installation.json remove projetos
```

`add` grava o caminho real e absoluto. Recusa `/`, a home inteira, o diretório de dados e um caminho com link simbólico no meio. O arquivo anterior fica em `installation.json.before-roots`. No fim, reinicie o gateway com o comando que ele imprimir.

### Projeto em outro servidor

No painel, em "Novo projeto", escolha "Outro servidor (SSH)". Copie a chave pública para o `~/.ssh/authorized_keys` do usuário nesse servidor. Informe host, porta e usuário, confira o fingerprint e confirme. Navegue até a pasta e crie. A cópia fica neste servidor. O resultado volta no branch `agent-control/…` do outro servidor. O branch principal de lá não muda.

## Instalar

1. PostgreSQL e Docker no servidor.
2. Crie um arquivo de instalação fora do repositório, modo `0600`, com `activation` igual a `personal`, `accountHomesDirectory` dentro de `dataDirectory`, o `databaseUrl` e o bloco `happier`.
3. `npm run personal:setup -- /caminho/instalacao.json`

O comando inicializa o ledger, o operador, o cofre se estiver no arquivo, e o `native-setup`. Se as imagens nativas ainda não existirem, rode `npm run personal:images -- /caminho/instalacao.json` (seção abaixo) e reinicie o gateway com o comando que ele imprimir.

### Imagens dos workers

O `claude` do host é um ELF dinâmico com glibc. A imagem Node Alpine não o executa (`no such file or directory` no interpretador). As imagens de planejamento e de execução usam Node Debian slim. O `grok` é estático e o Codex usado na imagem é o ELF musl do pacote npm, não o `codex.js`.

```bash
npm run personal:images -- <instalação.json>
```

O comando faz a sequência que antes era manual: acha o ELF do Codex em `$(npm root -g)/@openai` (o `codex` do PATH é um script e é recusado), usa `AC_NATIVE_CLAUDE_BIN` e `AC_NATIVE_GROK_BIN` se já estiverem exportados, roda `prepare-native-planning-image.mjs`, `prepare-native-execution-image.mjs` e `prepare-native-tools-image.mjs`, constrói as tags `ac-native-planning:personal`, `ac-native-execution:personal` e `ac-native-tools:personal`, exporta os três ids e roda `personal:setup`. No fim ele imprime o reinício do gateway. O nome do serviço é o diretório da instalação, ou o segundo argumento, o mesmo de `personal:services`:

```bash
systemctl --user restart agent-control-gateway-<nome>
```

Confira com `docker run --rm --entrypoint /usr/local/bin/claude ac-native-planning:personal --version`.

Para deixar no ar: `docker compose -f deploy/compose.personal.yml up -d`. O `restart: unless-stopped` sobe de novo depois de um reboot. O socket do Docker entra só no broker.

Um projeto sem arquivo de QA continua com o comando de hoje: roda na imagem de tools, sem rede, sobre uma cópia somente leitura do commit. Confere três coisas que não dependem de instalar nada: não há marcador de conflito de merge, todo `.json` é válido e todo `.js`, `.mjs` e `.cjs` passa em `node --check`.

Para rodar o preparo e os testes de um projeto, grave listas de argumentos. O primeiro item de cada lista é um destes nomes, resolvido no `PATH` da imagem: `npm`, `npx`, `pnpm`, `corepack`, `yarn`, `node`, `make` ou `sh`. Não é texto de shell. O preparo é opcional. Ele roda com a rede padrão do Docker, sem credencial e sem a conta de IA, numa cópia gravável do commit. O cache de dependências fica em `<dataDirectory>/qa-cache/<id>` e entra no contêiner em `/cache`. O teste roda em seguida, sem rede, na mesma cópia. O tempo fica entre 30 e 1800 segundos. Se o preparo falha, o QA falha com `QA_PREPARE_FAILED`. As últimas 40 linhas da saída aparecem na conversa.

`<projeto>` é o label ou o id. `set` grava o arquivo com modo 600. No fim, reinicie o gateway.

```bash
npm run personal:qa -- <instalação.json> <projeto> show
npm run personal:qa -- <instalação.json> IspAgent set --prepare '["corepack","pnpm","install","--frozen-lockfile"]' --test '["corepack","pnpm","--filter","@ispagent/shared","test"]' --timeout 600
npm run personal:qa -- <instalação.json> <projeto> clear
```

Para um teste que precisa de PostgreSQL, `set` aceita `--services` com um objeto JSON, não texto de shell. A imagem é `postgres:15-alpine`, `postgres:16-alpine` ou `postgres:17-alpine`.

```bash
npm run personal:qa -- <instalação.json> IspAgent set --prepare '["corepack","pnpm","install","--frozen-lockfile"]' --test '["corepack","pnpm","test"]' --services '{"postgres":{"image":"postgres:16-alpine","database":"qa_test"}}'
```

O preparo continua na rede padrão do Docker, sem banco. O teste entra só numa rede interna, sem porta publicada, com um Postgres efêmero. O nome do banco é o do JSON. O usuário e a senha nascem em cada execução, e a senha não entra no contrato nem no digest. O digest guarda a imagem e o nome do banco. O teste lê `QA_DATABASE_URL`. No fim, o contêiner do banco e a rede são removidos. Sem `--services`, o teste segue sem rede e o digest do contrato não muda.

`AC_PERSONAL_QA_ARGV` ainda substitui o comando dos projetos que não têm arquivo. O arquivo do projeto prevalece. Se o QA falhar, a tarefa é corrigida uma vez e, se falhar de novo, o gerente propõe um plano novo, uma única vez.

Sempre que reconstruir uma imagem ou mudar o QA, rode `npm run personal:images -- <instalação.json>` de novo e reinicie o gateway com o comando impresso. O setup atualiza os IDs das imagens, a política de qualidade e os modelos de plano das conversas.

## Ligar a conversa (Happier)

A conversa passa por um servidor Happier local. São três comandos, uma vez só:

```bash
npm run personal:happier -- <instalacao>          # servidor Happier; deixe rodando (tmux, systemd)
npm run gateway -- personal-connect <instalacao>  # cria sua conta Happier, a conversa do projeto e o cofre
npm run gateway -- serve <instalacao>             # o gateway; deixe rodando
```

Se o `yarn` reclamar de `.prisma/client`, rode uma vez `yarn -s generate:providers` em `upstream/happier/apps/server`.

O `personal-connect` grava em `dataDirectory` o segredo da conta (`happier-account.key`) e o token. Faça backup desse arquivo: ele é a sua conta e a chave da conversa. Rodar o comando de novo só renova o token.

### Conversar pelo terminal

A conversa mostra cada papel pelo nome, com provedor, modelo e esforço: o gerente montando o plano, o programador começando e terminando (com o que ele disse, o commit e os arquivos alterados), o resultado do QA e o veredito do revisor com os apontamentos. O histórico fica na própria conversa, então aparece também no app.

```bash
npm run gateway -- say <instalacao> "o que este repositório faz?"
npm run gateway -- say <instalacao> "crie docs/guia.md com ..."   # chega a proposta com as tarefas
npm run gateway -- say <instalacao> aprovar                        # ou: descartar, pare
npm run gateway -- say <instalacao> equipe                         # quem é gerente, programador e revisor, e o que cada um fez por último
npm run gateway -- chat-log <instalacao> 600                       # acompanha a conversa por 600 s
npm run gateway -- chat-log <instalacao>                           # histórico
```

A mensagem é cifrada com a sua chave e entra na fila do Happier como no aplicativo. O gateway avisa cada etapa (programação, review, qa, integrate) e o resultado. Ao integrar no branch que está aberto no repositório, os arquivos no disco avançam junto; se você tiver uma edição local no mesmo arquivo, o disco não é tocado e o `git status` mostra a diferença.

### Aplicativo Happier

O aplicativo é o Happier oficial: iOS na App Store, Android no Google Play, desktop (Windows, macOS, Linux) em happier.dev/download e web em cloud.happier.dev. Ele precisa alcançar o **seu** servidor Happier, que só escuta em `127.0.0.1` no servidor.

1. Mostre a chave da conta (só no seu terminal; ela é a conta e a chave da conversa):
   ```bash
   npm run gateway -- app-key <instalacao>
   ```
   A saída traz o endereço do servidor (por exemplo `http://127.0.0.1:38343`) e a chave no formato `XXXXX-XXXXX-…`.
2. Leve o servidor até o aparelho:
   - **Computador (Windows):** abra um túnel SSH e deixe-o aberto: `ssh -N -L 38343:127.0.0.1:38343 usuario@servidor`.
   - **Celular, com subdomínio seu (recomendado aqui):** aponte um registro A do subdomínio para o IP do servidor e rode `npm run personal:public -- <instalacao> <subdominio>`. O comando confere o DNS, cria o site no Caddy do servidor (`/home/app/infra/caddy/sites/happier-<nome>.caddy`, certificado Let's Encrypt automático), recarrega o Caddy, fecha o cadastro anônimo do Happier (a sua conta continua entrando; contas novas são recusadas) e testa o endereço HTTPS. Com `--check` ele só confere o DNS.
   - **Celular, sem subdomínio:** o celular não alcança `127.0.0.1` do servidor. Use uma rede privada como o Tailscale (instalado no servidor e no celular; no servidor, `tailscale serve --bg http://127.0.0.1:38343` publica em HTTPS só para a sua rede) ou um proxy HTTPS seu.
3. No app, em **Servidor**, adicione o endereço (`http://127.0.0.1:38343` pelo túnel, ou o endereço HTTPS do Tailscale) e selecione-o.
4. Escolha **Restaurar conta → Restaurar com chave secreta** e cole a chave.
5. A conversa do projeto aparece na lista de sessões. Escreva nela como no terminal: pergunta, pedido, `aprovar`, `descartar`, `pare`, `equipe`.

Este caminho segue a documentação do Happier, mas ainda não foi testado num aparelho de verdade.

### Painel no celular (Cezar)

O gateway serve a tela do Cezar presa ao projeto: as execuções, o fluxo de cada uma (programar, revisar, QA, integrar), o relato de cada papel e os commits. Ela é só de leitura: os pedidos, `aprovar` e `pare` continuam pela conversa do Happier. Para abrir no celular e instalar como app:

```bash
npm run personal:cockpit -- ~/.agent-control/meuprojeto/installation.json painel.seudominio.com
```

Precisa de um registro DNS A próprio (diferente do Happier) e do Happier já publicado (`personal:public`). O script cria o site no Caddy, aponta a instalação para o endereço HTTPS e reinicia o gateway. No celular: abra o endereço, toque em "Entrar pelo Happier", depois em "Autorizar no aplicativo Happier", aprove no app e volte; no menu do navegador use "Adicionar à tela inicial". Cada projeto tem o próprio painel.

### Entrar sem o app Happier

No servidor, com o gateway parado ou em outro terminal:

```bash
npm run gateway -- pair <instalação.json>
```

O comando imprime um código de 8 caracteres, válido por 10 minutos e de uso único. No painel, "Entrar com código" abre a sessão do dono. "Entrar pelo Happier" continua disponível. Depois de cinco códigos errados em um minuto, a entrada espera um minuto.

### Entrar com usuário e senha

No servidor, com o gateway parado ou em outro terminal:

```bash
npm run gateway -- password <instalação.json> <usuário>
```

O comando pede a senha duas vezes e não a mostra. Ele grava só o hash em `panel-login.json`, no diretório de dados da instalação, com modo `0600`. O usuário tem de 3 a 40 caracteres (`a-z`, `0-9`, `.`, `_` e `-`) e não diferencia maiúsculas. A senha tem de 12 a 200 caracteres. No painel, o formulário aparece primeiro, com o botão "Entrar". "Entrar com código" e "Entrar pelo Happier" ficam abaixo. A sessão deste login dura 30 dias. Depois de cinco erros em um minuto, aquele endereço espera um minuto.

Se a variável `AC_PANEL_PASSWORD` já existir, o comando usa esse valor e não pergunta. Para apagar a credencial:

```bash
npm run gateway -- password <instalação.json> --remove
```

### Avisos no celular

Na Conversa, o sino pede permissão e inscreve o aparelho em "Ativar avisos neste aparelho". "Enviar teste" manda "Teste do Agent Control". O aviso abre a conversa do projeto. No iPhone, os avisos só chegam com o painel instalado na tela inicial (iOS 16.4 ou mais novo); fora do app instalado a tela explica isso. O service worker não guarda páginas nem respostas da API.

## Conversar sem o Happier

O campo opcional `managerTransport.transport` escolhe onde a conversa fica. Sem o campo, ou com `"happier"`, vale a seção anterior, igual a hoje. `"local"` grava a conversa na tabela `ac_personal_messages`. Só uma instalação com `activation` `personal` aceita `"local"`. O bloco `happier`, o `tokenFile` e o `machineId` continuam no JSON; o transporte local não lê o token nem a máquina.

Instalação nova:

```bash
npm run personal:project -- <repositório> --db <postgresql://...> --local
```

Numa instalação que já existe:

```bash
npm run gateway -- personal-connect <instalação.json> --local
```

`npm run personal:services -- <instalação.json>` sobe só o gateway. Não desliga um unit Happier que já exista. Não apague `happier-account.key`, o SQLite do Happier nem o bloco `happier`.

No painel, a senha e o código emitem o cookie sem consultar o Happier. "Entrar pelo Happier" não aparece. `GET /api/v1/ac/auth/config` responde `enabled: false`.

### Passar uma conversa que já está no Happier

Rode o importador **antes** de gravar `"local"`, com o Happier ainda no ar. Ele copia cada contexto de `managerTransport.contexts`, na ordem cronológica, sem abrir pedido novo. Rodar de novo não duplica. Se o transporte já estiver `local`, a repetição continua válida, mas o lugar dela é antes da troca.

O banco precisa das migrações `db/migrations/097_personal_messages.sql` e `098_browser_session_local.sql`. O `serve` não as aplica. Não use `initialize` numa instalação já em uso para obtê-las: esse comando também registra o projeto pelo `project.owner`, que pode não ser o principal do Happier.

No exemplo em que o diretório de dados se chama `ispagent`, os units são `agent-control-gateway-ispagent` e `agent-control-happier-ispagent`. Troque o nome se o diretório for outro.

```bash
npm run personal:backup -- <instalação.json> /caminho/vazio
npm run gateway -- import-conversation <instalação.json>
```

Confira, ainda com o painel no Happier, a contagem e uma frase conhecida. A tabela `ac_personal_messages` tem de bater com essa contagem.

No JSON, grave `"transport": "local"` dentro de `managerTransport`. Não apague `happier`, `tokenFile`, `machineId`, a chave nem o SQLite.

```bash
systemctl --user restart agent-control-gateway-ispagent
```

Faça um pedido curto no painel. A linha do titular entra na tabela, o gerente responde, e o Happier não precisa responder.

Antes de parar o Happier, procure nas outras instalações um arquivo `happier-shared-from` apontando para esta. Se não houver:

```bash
systemctl --user disable --now agent-control-happier-ispagent
```

Não use `npm run personal:services -- <instalação.json> --remove`: esse comando também para o gateway.

### Voltar ao Happier

Enquanto a chave e o SQLite continuam no disco:

1. Grave `"transport": "happier"`, ou retire a chave `transport` (o padrão é `happier`).
2. `systemctl --user enable --now agent-control-happier-ispagent`
3. `systemctl --user restart agent-control-gateway-ispagent`

O histórico antigo continua no SQLite. O que foi escrito só na tabela nova não volta sozinho para o Happier. Se não houve conversa nova depois do corte, a volta é o histórico anterior. Não há reexportação. O Caddy de `personal:public` deixa de ver o Happier em `/v1`; isso não derruba o painel. Não recrie o site.

## Adicionar contas

Só contas que você possui.

Neste teste o gerente e o revisor usam Claude Sonnet 5.5 em esforço médio. O programador usa Grok 4.7 em esforço médio. O QA permanece no Claude. A equipe permanente do `AGENTS.md` não muda.

```bash
npm run gateway -- account-add /caminho/instalacao.json claude "Claude"
npm run gateway -- account-add /caminho/instalacao.json grok "Grok"
```

O comando mostra a URL e o código. Abra a URL, informe o código e conclua o login. Para copiar um login que já é seu, sem movê-lo:

```bash
npm run gateway -- account-add <instalacao> claude Claude --auth-file "$HOME/.claude/.credentials.json"
npm run gateway -- account-add <instalacao> grok Grok --auth-file "$HOME/.grok/auth.json"
npm run gateway -- account-add <instalacao> codex Codex --auth-file "$HOME/.codex/auth.json"
```

O arquivo do Claude fica em `.credentials.json` da home da conta. O do Grok fica em `.grok/auth.json`. O painel também tem **Adicionar conta**. Esse botão executa o CLI no processo do gateway. A imagem `deploy/Dockerfile.personal` instala os CLIs; se você subir o gateway no host, o `account-add` acima já basta. Alternar contas quando a cota acaba pode violar os termos do provedor; a decisão é sua.

## Cadastrar o projeto e o primeiro pedido

O projeto do arquivo de instalação já entra no ledger. Na conversa, publique o fluxo "Gerente planeja a solicitação" e uma política de revisão. Escreva o pedido, por exemplo "crie CONTRIBUTING.md e referencie no README". Antes de planejar, o gerente decide se a mensagem é pergunta (responde na conversa) ou pedido de mudança (devolve a proposta). Se uma tarefa falhar, o gerente recebe o pedido original e propõe um plano corrigido uma vez. Responda `aprovar` ou `descartar`. A aprovação automática, desligada por padrão, é `POST /api/v1/ac/personal/auto-approve` com `{"enabled":true}`.

## Backup

O backup leva a chave da conta Happier, os logins, a chave SSH, o cofre, o banco e o resto do diretório de dados (sem `native/`, `qa-cache/` nem `remote/`). Ele contém segredos. Guarde-o fora do servidor e fora do repositório.

```bash
npm run personal:backup -- ~/.agent-control/meuprojeto/installation.json /caminho/vazio
npm run personal:restore-check -- /caminho/vazio/agent-control-meuprojeto-AAAAMMDD-HHMM
```

O destino tem que ser uma pasta vazia, fora do diretório de dados e fora dos repositórios dos projetos. O comando cria dentro dela `agent-control-<label>-<AAAAMMDD-HHMM>`. `personal:restore-check` só confere o `MANIFEST.txt` e se o `database.dump` é legível. Não restaura nada.

## Logs e atualização

Logs do gateway: `docker compose -f deploy/compose.personal.yml logs -f gateway`.

Atualizar: `git pull` no servidor, `npm install`, suba o compose de novo. Não use `git push --force`.

## Servidor SSH com usuário e senha

Em "Novo projeto" → "Outro servidor (SSH)" → "Adicionar servidor", informe host, porta, usuário e senha, toque em "Conferir identidade" e depois em "Confirmar e conectar". A senha é usada uma única vez, só depois de você confirmar a identidade do servidor, para instalar a chave do Agent Control no `~/.ssh/authorized_keys` desse usuário; ela não é guardada. As conexões seguintes usam a chave. Cinco senhas erradas bloqueiam novas tentativas naquele servidor por 10 minutos. Quem preferir pode usar "Prefiro colar a chave eu mesmo" e confirmar sem senha.
