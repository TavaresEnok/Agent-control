# Uso pessoal

Um titular, no servidor, pelo Happier. Sem este opt-in o sistema continua bloqueado.

## Instalar

1. PostgreSQL e Docker no servidor.
2. Crie um arquivo de instalação fora do repositório, modo `0600`, com `activation` igual a `personal`, `accountHomesDirectory` dentro de `dataDirectory`, o `databaseUrl` e o bloco `happier`.
3. `npm run personal:setup -- /caminho/instalacao.json`

O comando inicializa o ledger, o operador, o cofre se estiver no arquivo, e o `native-setup`. Se as imagens nativas ainda não existirem, exporte `AC_NATIVE_PLANNING_IMAGE`, `AC_NATIVE_WORKER_IMAGE` e `AC_NATIVE_TOOLS_IMAGE` (`sha256:...`) e rode `npm run gateway -- native-setup /caminho/instalacao.json` de novo.

### Imagens dos workers

Os workers rodam o CLI de cada provedor dentro do contêiner. Ao preparar as imagens de planejamento e de execução, aponte os binários ELF do Claude e do Grok:

```bash
export AC_NATIVE_CLAUDE_BIN=$(readlink -f $(which claude))
export AC_NATIVE_GROK_BIN=$(readlink -f $(which grok))
node scripts/prepare-native-planning-image.mjs /caminho/codex-elf <sha256-do-codex>
node scripts/prepare-native-execution-image.mjs /caminho/codex-elf <sha256-do-codex>
```

O script do Codex exige o binário ELF público, não o wrapper Node do `npm`. Sem `AC_NATIVE_CLAUDE_BIN` ou `AC_NATIVE_GROK_BIN`, o gerente Claude e o programador Grok falham dentro do contêiner. Construa cada contexto com `docker build` e use os IDs `sha256:` nas variáveis acima.

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

O comando mostra a URL e o código. Abra a URL, informe o código e conclua o login. Para importar um `auth.json` que já é seu: acrescente `--auth-file /caminho/auth.json`. O painel tem o botão **Adicionar conta** com o mesmo fluxo, mas no compose o contêiner do gateway não tem os CLIs. Rode `account-add` no host. Alternar contas quando a cota acaba pode violar os termos do provedor; a decisão é sua.

## Cadastrar o projeto e o primeiro pedido

O projeto do arquivo de instalação já entra no ledger. Na conversa, publique o fluxo "Gerente planeja a solicitação" e uma política de revisão. Escreva o pedido, por exemplo "crie CONTRIBUTING.md e referencie no README". Antes de planejar, o gerente decide se a mensagem é pergunta (responde na conversa) ou pedido de mudança (devolve a proposta). Se uma tarefa falhar, o gerente recebe o pedido original e propõe um plano corrigido uma vez. Responda `aprovar` ou `descartar`. A aprovação automática, desligada por padrão, é `POST /api/v1/ac/personal/auto-approve` com `{"enabled":true}`.

## Logs, backup e atualização

Logs do gateway: `docker compose -f deploy/compose.personal.yml logs -f gateway`.

Backup: `npm run gateway -- vault-backup /caminho/instalacao.json <destino>` e `pg_dump` da base. Guarde os dois fora do repositório.

Atualizar: `git pull` no servidor, `npm install`, suba o compose de novo. Não use `git push --force`.
