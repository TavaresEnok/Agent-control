# Pacote para a revisão de segurança externa

Criado em 16/11/2026. O `AGENTS.md` exige revisão humana ou de outro provedor antes de produção real. As revisões feitas até agora foram por modelos Claude e não substituem essa revisão. Este documento diz ao revisor o que olhar, por onde começar e como rodar.

## O que é o sistema

Agent Control coordena agentes de programação (Claude, Grok e Codex) num servidor do titular. Um gerente conversa com o titular, propõe um plano, e, depois da aprovação, programadores, QA e revisor trabalham em contêineres Docker isolados. O resultado só entra no branch do projeto depois de QA e revisão aprovarem.

Modo em uso: `activation:"personal"`, um único titular. O modo `locked` não deve mudar.

## Superfície exposta

| Entrada | Onde | Quem pode |
|---|---|---|
| Painel e API HTTP do gateway | `src/api.ts`, `src/server-main.ts`; público em HTTPS via Caddy (`/home/app/infra/caddy/sites/happier-ispagent.caddy`) | titular com sessão |
| Login do painel | `src/personal-login.ts`, `src/personal-password.ts` (usuário e senha, hash em `panel-login.json`, limite de 5 erros por minuto) | qualquer um na internet |
| Entrada por código de uso único | `src/personal-pair.ts` | quem tem o código |
| Avisos Web Push | `src/personal-push.ts`, `src/panel-service-worker.ts` | titular |
| Projetos por SSH | `src/personal-ssh.ts`, `src/remote-*.ts` (chave própria em `<dataDirectory>/ssh`, identidade do servidor fixada) | titular |
| Pastas locais | `src/personal-folders.ts` (só dentro de `projectRoots`) | titular |
| Contêineres dos agentes | `src/native-execution-*.ts`, `src/native-qa*.ts`, `src/native-planning-*.ts` | código gerado por modelo, não confiável |

Rotas do modo pessoal: `grep -n "'/api/v1/ac/personal" src/api.ts`. Hoje são 27. Vinte e quatro passam por `requireInstallationOwner`; `conversation`, `messages` e `auto-approve` conferem o dono do projeto (`projectOwnership`). Vale conferir se essa diferença é intencional.

## Onde olhar primeiro

1. **Autenticação do painel** e sessão (30 dias): força bruta, fixação de sessão, CSRF nas rotas `POST`/`PUT`/`DELETE`, cabeçalhos de cookie.
2. **Isolamento dos contêineres** dos agentes: rede (`ac-native-provider`, rede interna do QA), montagens, usuário, limites, e o que um agente malicioso consegue ler do host (logins das contas em `<dataDirectory>/accounts`).
3. **Montagem de comandos**: `docker`, `git`, `ssh`, `rsync`, `pg_dump`, `pg_restore`, `journalctl`. Procure argumento vindo do usuário ou do modelo sem validação (`grep -n "spawn\|execFile" src/*.ts`).
4. **Caminhos**: navegação de pastas local e remota, `..`, links simbólicos, escrita só nos caminhos da tarefa (`src/quality-gate-paths.ts`, `src/remote-write-paths.ts`).
5. **Segredos**: cofre (`src/context-vault*.ts`), backup (`src/personal-backup*.ts`, contém segredos), redação de logs (`src/native-execution-redaction.ts`), avisos e mensagens que vão ao celular.
6. **Integração no Git**: só depois de QA e revisão; nada de `push --force`; push remoto só para `agent-control/*`.

## Como rodar

```bash
npm install
npm run typecheck
AC_TEST_DATABASE_URL=postgresql://usuario:senha@127.0.0.1:porta/banco_descartavel npm test
```

`npm test` deixa de fora os arquivos que precisam do laboratório (Docker, SSH, Happier, `sudo`) e os lista em `excluded`. Os passos de laboratório estão em `deploy/compose.lab.yml` e `.github/workflows/isolated-ci.yml`.

## O que já foi revisado

- Revisões independentes por modelo Claude distinto (Sonnet 5.5), registradas em `docs/PLANO-PAINEL-E-PROJETOS.md` (Fase 7: sem achado alto, 12 médios e baixos corrigidos) e no histórico de commits.
- Nenhuma revisão humana ou de outro provedor até 16/11/2026.

## O que entregar

Uma lista de achados com gravidade, o arquivo e a linha, um cenário de ataque concreto e a correção sugerida. Os achados altos bloqueiam o uso em produção real.
