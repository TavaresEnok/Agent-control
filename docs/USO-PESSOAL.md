# Uso pessoal

Um titular, no servidor, pelo Happier. Sem este opt-in o sistema continua bloqueado.

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

O comando de QA roda na imagem de tools, sem rede, sobre uma cópia somente leitura do commit. O padrão é `node --version`, que só prova que o contêiner sobe. Para um QA de verdade, exporte `AC_PERSONAL_QA_ARGV` antes do `personal:setup`, com um JSON cujo primeiro item é um executável absoluto, por exemplo `'["/usr/local/bin/node","--test"]'`. Se o QA falhar, a tarefa é corrigida uma vez e, se falhar de novo, o gerente propõe um plano novo, uma única vez.

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

```bash
npm run gateway -- say <instalacao> "o que este repositório faz?"
npm run gateway -- say <instalacao> "crie docs/guia.md com ..."   # chega a proposta com as tarefas
npm run gateway -- say <instalacao> aprovar                        # ou: descartar, pare
npm run gateway -- chat-log <instalacao> 600                       # acompanha a conversa por 600 s
npm run gateway -- chat-log <instalacao>                           # histórico
```

A mensagem é cifrada com a sua chave e entra na fila do Happier como no aplicativo. O gateway avisa cada etapa (programação, review, qa, integrate) e o resultado. Ao integrar no branch que está aberto no repositório, os arquivos no disco avançam junto; se você tiver uma edição local no mesmo arquivo, o disco não é tocado e o `git status` mostra a diferença.

### Aplicativo Happier

Para usar o aplicativo no celular ou o cliente web, ele precisa apontar para o seu servidor Happier (a porta de `happier.upstreamOrigin`, publicada por um proxy HTTPS ou túnel seu) e entrar com a mesma conta, restaurando-a pela chave secreta. Esse caminho não foi testado nesta rodada; o terminal acima foi.

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
