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

Para o novo projeto aparecer como mais uma conversa no app que você já usa (mesmo servidor, mesma chave), passe a instalação que roda o Happier:

```bash
npm run personal:project -- /caminho/do/outro --db postgresql://.../banco_novo --label outro --share-happier ~/.agent-control/ispagent/installation.json
```

Ele copia a chave da conta e usa o mesmo Happier; `personal:services` instala só o gateway desse projeto. Cada projeto continua com o próprio banco e os próprios logins, porque um login copiado de outro projeto expira quando o outro renova o token.

O app não abre projeto novo sozinho: "nova sessão" numa pasta pede um daemon do Happier na máquina, e o Agent Control não roda um. Por isso a máquina "agent-control" aparece offline. As conversas dos projetos ligados aqui funcionam mesmo assim.

## Instalar

1. PostgreSQL e Docker no servidor.
2. Crie um arquivo de instalação fora do repositório, modo `0600`, com `activation` igual a `personal`, `accountHomesDirectory` dentro de `dataDirectory`, o `databaseUrl` e o bloco `happier`.
3. `npm run personal:setup -- /caminho/instalacao.json`

O comando inicializa o ledger, o operador, o cofre se estiver no arquivo, e o `native-setup`. Se as imagens nativas ainda não existirem, exporte `AC_NATIVE_PLANNING_IMAGE`, `AC_NATIVE_WORKER_IMAGE` e `AC_NATIVE_TOOLS_IMAGE` (`sha256:...`) e rode `npm run gateway -- native-setup /caminho/instalacao.json` de novo.

### Imagens dos workers

O `claude` do host é um ELF dinâmico com glibc. A imagem Node Alpine não o executa (`no such file or directory` no interpretador). As imagens de planejamento e de execução usam Node Debian slim. O `grok` é estático e o Codex usado na imagem é o ELF musl do pacote npm, não o `codex.js`.

```bash
export AC_NATIVE_CLAUDE_BIN=$(readlink -f $(which claude))
export AC_NATIVE_GROK_BIN=$(readlink -f $(which grok))
# o ELF do Codex fica dentro do pacote npm; o `codex` do PATH é um script e é recusado
ELF=$(find "$(npm root -g)/@openai" -type f -name codex -size +1M | head -1)
SHA=$(sha256sum "$ELF" | awk '{print $1}')
node scripts/prepare-native-planning-image.mjs "$ELF" "$SHA"
node scripts/prepare-native-execution-image.mjs "$ELF" "$SHA"
node scripts/prepare-native-tools-image.mjs "$ELF" "$SHA"
docker build -t ac-native-planning:personal <contexto-planning>
docker build -t ac-native-execution:personal <contexto-execution>
docker build -t ac-native-tools:personal <contexto-tools>
export AC_NATIVE_PLANNING_IMAGE=$(docker image inspect ac-native-planning:personal --format '{{.Id}}')
export AC_NATIVE_WORKER_IMAGE=$(docker image inspect ac-native-execution:personal --format '{{.Id}}')
export AC_NATIVE_TOOLS_IMAGE=$(docker image inspect ac-native-tools:personal --format '{{.Id}}')
```

Confira com `docker run --rm --entrypoint /usr/local/bin/claude ac-native-planning:personal --version`.

Para deixar no ar: `docker compose -f deploy/compose.personal.yml up -d`. O `restart: unless-stopped` sobe de novo depois de um reboot. O socket do Docker entra só no broker.

O comando de QA roda na imagem de tools, sem rede, sobre uma cópia somente leitura do commit. O padrão confere três coisas que não dependem de instalar nada: não há marcador de conflito de merge, todo `.json` é válido e todo `.js`, `.mjs` e `.cjs` passa em `node --check`. Para rodar os testes do projeto, exporte `AC_PERSONAL_QA_ARGV` antes do `personal:setup`, com um JSON cujo primeiro item é um executável absoluto, por exemplo `'["/usr/local/bin/node","--test"]'`. Se o QA falhar, a tarefa é corrigida uma vez e, se falhar de novo, o gerente propõe um plano novo, uma única vez.

Sempre que reconstruir uma imagem ou mudar o QA, rode `personal:setup` de novo e reinicie o gateway. O setup atualiza os IDs das imagens, a política de qualidade e os modelos de plano das conversas.

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

## Logs, backup e atualização

Logs do gateway: `docker compose -f deploy/compose.personal.yml logs -f gateway`.

Backup: `npm run gateway -- vault-backup /caminho/instalacao.json <destino>` e `pg_dump` da base. Guarde os dois fora do repositório.

Atualizar: `git pull` no servidor, `npm install`, suba o compose de novo. Não use `git push --force`.
