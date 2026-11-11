# Ordem para o Grok — Fase 0, passo de limpeza do painel

Escrita pelo gerente (Claude) em 11/11/2026. Abra o Grok com `cd /home/app/projects/agent-control && grok -m grok-4.7 --effort medium` e cole tudo abaixo da linha.

---

Você é o programador do Agent Control. O roteiro está em `docs/PLANO-PAINEL-E-PROJETOS.md`. Leia as seções "Decisões já tomadas", "Regras fixas" e "Fase 0" antes de começar. Faça **só este passo**. Quando terminar, pare e escreva o relatório pedido no fim.

## Contexto

O painel é a página web do Cezar, servida pelo gateway do IspAgent em `https://agentcontrol.tokstiloesporte.com`. O código da página está em `upstream/cezar/packages/web/src`. No Agent Control ela roda com `import.meta.env.VITE_AGENT_CONTROL_MANAGED==='1'`; veja como `components/composer/composer.tsx` e `app.tsx` usam isso. Hoje o painel só lê: os pedidos ainda passam pela conversa do Happier.

## O que fazer

Toda mudança na página vale **só quando `VITE_AGENT_CONTROL_MANAGED==='1'`**. Fora disso, o Cezar continua igual.

1. **Tirar a dica de assumir a sessão.** Em `routes/task-thread/run-header.tsx` e `routes/task-thread/run-actions.ts` há a dica "claude --resume" (`resumeHint`) e o "Open in…" para continuar a sessão num terminal. No Agent Control isso não funciona: o trabalho roda em workers isolados. Esconda os dois.
2. **Tirar o seletor de agente e modelo da caixa de continuar.** Na tela da tarefa aparece um seletor claude/opus que não tem efeito: quem escolhe o modelo é o Agent Control. Esconda o seletor. Não mexa no resto da caixa; ela será trocada na Fase 1.
3. **Parar os erros 403 inofensivos.** A página chama `GET /api/v1/star-count`, `GET /api/v1/workspace/agent-profiles` (e `.../fallback-policy`) e a atualização de skills. O gateway recusa e aparecem erros. Em `src/api.ts`, no bloco que já responde as chamadas de controle da página (procure `seenRuns` e as respostas de `read`/`unread`, `telemetry` e `ui-state`), responda esses **GET** com o formato vazio que o cliente espera. Os tipos estão em `upstream/cezar/packages/web/src/api/client.ts`. Considere também a variante com `/api/v1/p/<projeto>/…`. A atualização de skills pode responder "nada a atualizar" se for só consulta. Qualquer escrita de verdade continua recusada.

## Como verificar

- `npm run typecheck` sai 0.
- Rode os testes que existirem para os arquivos que você mudou. Não rode a suíte inteira.
- `VITE_AGENT_CONTROL_MANAGED=1 npm --prefix upstream/cezar run build:web` sai 0.
- Reinicie o gateway com `systemctl --user restart agent-control-gateway-ispagent` e confira:
  - `curl -s -o /dev/null -w '%{http_code}\n' https://agentcontrol.tokstiloesporte.com/manifest.webmanifest` dá 200;
  - `curl -s -o /dev/null -w '%{http_code}\n' https://agentcontrol.tokstiloesporte.com/v1/account/profile` dá 401 (o Happier continua no ar).
- Não é preciso abrir a página logado; o gerente confere a tela.

## Regras

- Sem push e sem reescrever o histórico. Não toque em `docs/PROMPT-GROK-*.md` nem em `docs/PROXIMA-ORDEM.md`.
- Não mude o modo `locked` nem nada fora do modo pessoal ou gerenciado.
- Sem testes de tela ou de texto.
- Um commit por item (1, 2 e 3), com autor e committer `Enok Tavares <migration@localhost>`:

  ```
  GIT_AUTHOR_NAME="Enok Tavares" GIT_AUTHOR_EMAIL="migration@localhost" GIT_COMMITTER_NAME="Enok Tavares" GIT_COMMITTER_EMAIL="migration@localhost" git commit -m "<frase curta>"
  ```

- Nenhum segredo em commit ou log.
- Se travar por algo que só o titular pode fazer, descreva a ação exata e pare. Não fique mais de 15 minutos sem progresso: se não achar o caminho, pare e relate.

## Relatório final (escreva no chat)

- Os hashes dos commits e uma linha sobre cada um.
- A saída resumida de cada verificação acima (comando e resultado).
- O que você não conseguiu fazer ou não conferiu.
