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
ELF=$(readlink -f $(which codex) | sed 's#/bin/codex$#/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex#')
# se o sed não achar o arquivo, procure vendor/x86_64-unknown-linux-musl/bin/codex dentro de @openai/codex
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

## Parear o Happier

Abra o painel do gateway e use o pareamento já existente do Happier. Vincule a conversa do projeto em Settings → Agent Control.

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
