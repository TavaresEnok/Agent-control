# Uso pessoal

Um titular, no servidor, pelo Happier. Sem este opt-in o sistema continua bloqueado.

## Instalar

1. PostgreSQL e Docker no servidor.
2. Crie um arquivo de instalação fora do repositório, modo `0600`, com `activation` igual a `personal`, `accountHomesDirectory` dentro de `dataDirectory`, o `databaseUrl` e o bloco `happier`.
3. `npm run personal:setup -- /caminho/instalacao.json`

O comando inicializa o ledger, o operador, o cofre se estiver no arquivo, e o `native-setup`. Se as imagens nativas ainda não existirem, exporte `AC_NATIVE_PLANNING_IMAGE`, `AC_NATIVE_WORKER_IMAGE` e `AC_NATIVE_TOOLS_IMAGE` (`sha256:...`) e rode `npm run gateway -- native-setup /caminho/instalacao.json` de novo.

Para deixar no ar: `docker compose -f deploy/compose.personal.yml up -d`. O `restart: unless-stopped` sobe de novo depois de um reboot. O socket do Docker entra só no broker.

## Parear o Happier

Abra o painel do gateway e use o pareamento já existente do Happier. Vincule a conversa do projeto em Settings → Agent Control.

## Adicionar contas

Só contas que você possui.

```bash
npm run gateway -- account-add /caminho/instalacao.json codex "Codex"
npm run gateway -- account-add /caminho/instalacao.json claude "Claude"
```

O comando mostra a URL e o código. Abra a URL, informe o código e conclua o login. Para importar um `auth.json` que já é seu: acrescente `--auth-file /caminho/auth.json`. O painel tem o botão **Adicionar conta** com o mesmo fluxo. Alternar contas quando a cota acaba pode violar os termos do provedor; a decisão é sua.

## Cadastrar o projeto e o primeiro pedido

O projeto do arquivo de instalação já entra no ledger. Na conversa, publique o fluxo "Gerente planeja a solicitação" e uma política de revisão. Escreva o pedido, por exemplo "crie CONTRIBUTING.md e referencie no README". O gerente devolve a proposta. Responda `aprovar` ou `descartar`. A aprovação automática, desligada por padrão, é `POST /api/v1/ac/personal/auto-approve` com `{"enabled":true}`.

## Logs, backup e atualização

Logs do gateway: `docker compose -f deploy/compose.personal.yml logs -f gateway`.

Backup: `npm run gateway -- vault-backup /caminho/instalacao.json <destino>` e `pg_dump` da base. Guarde os dois fora do repositório.

Atualizar: `git pull` no servidor, `npm install`, suba o compose de novo. Não use `git push --force`.
