# Ordem para o Grok — Fase 1, parte A: ler e enviar a conversa pelo gateway

Escrita pelo gerente (Claude) em 11/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço médio.

---

Você é o programador do Agent Control. O roteiro está em `docs/PLANO-PAINEL-E-PROJETOS.md`. Leia "Decisões já tomadas", "Regras fixas" e "Fase 1". Faça **só os passos 1.1 e 1.2**. A tela é a parte B, numa próxima ordem.

## Contexto

- O titular conversa com o gerente numa sessão do Happier, cifrada. A ponte entre essa conversa e o Agent Control está em `src/happier.ts`:
  - `accept()` recebe a mensagem do titular e decide se é pergunta, pedido ou palavra de controle (`aprovar`, `descartar`, `pare`, `equipe`);
  - `say()` escreve as respostas;
  - `receivePending()` busca as mensagens novas do titular;
  - `recoverHistory()` lê o histórico.
- O gateway do modo pessoal monta essa ponte em `src/managers.ts` e `src/manager-transport.ts`. As rotas do painel ficam em `src/api.ts`, e as rotas pessoais já existentes usam `personalAccounts`.
- O login do painel já existe: as rotas em `/api/v1/ac/...` recebem o `principal` autenticado. Siga o padrão das rotas vizinhas.

## O que fazer

1. **`GET /api/v1/ac/personal/conversation?after=<cursor>&limit=<n>`** — mensagens da conversa do projeto em ordem, decifradas:
   - formato `{messages:[{id,role:'owner'|'manager',text,createdAt}],next:<cursor|null>}`;
   - `limit` padrão 50, máximo 200;
   - sem `after`, traz as mais recentes.

   Reaproveite a leitura e a decifragem que a ponte já usa. Não invente outro jeito de decifrar. Mensagens que não são texto (eventos internos) ficam de fora.
2. **`POST /api/v1/ac/personal/messages`** com `{text, clientId}`:
   - `text` com 1 a 8000 caracteres;
   - `clientId` com 8 a 64 caracteres em `[A-Za-z0-9_-]`;
   - a mensagem entra pelo **mesmo caminho** de uma mensagem do app, para que o app Happier também a veja e a ponte a processe como hoje.

   Primeiro investigue se a mensagem pode ser gravada como do titular na sessão do Happier, com a chave e o token que o gateway já tem, e depois apanhada por `receivePending`. Se puder, faça assim.

   Se não puder, chame `accept()` do transporte do contexto com `localId` derivado do `clientId` e escreva o texto do titular na conversa, para ele aparecer no histórico. Escreva no relatório qual caminho usou e por quê.

   O mesmo `clientId` enviado duas vezes não pode gerar dois pedidos: devolva o mesmo resultado. A resposta é `202 {id}`.

Regras das duas rotas:

- só existem com `personalAccounts`, isto é, no modo pessoal;
- exigem login;
- valem só para o contexto do projeto deste gateway;
- nunca devolvem chave, token nem texto cifrado.

## Teste essencial (um arquivo em `tests/`)

Um teste que **não precise de PostgreSQL** e cubra:

- as duas rotas recusam sem login;
- as duas rotas não existem fora do modo pessoal;
- o mesmo `clientId` duas vezes resulta numa entrada só.

Se a rota depender do banco, isole a parte que valida e deduplica numa função pura e teste essa função. Rode com `npx tsx --test tests/<arquivo>`.

## Permissões nesta execução (não tem tela)

- Você só pode editar arquivos em `src/` e `tests/`, com suas ferramentas de arquivo.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Qualquer outro comando encerra a execução. O build, o restart do gateway e a prova real ficam com o gerente.

## Regras

- Sem push. Não toque em `docs/PROMPT-GROK-*.md` nem em `docs/PROXIMA-ORDEM.md`. Não mude nada do modo `locked`.
- Commits pequenos (um para a leitura, um para o envio, o teste junto do código que ele cobre).
- Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude. O autor já está no ambiente; não rode `git config`.
- Nenhum segredo em código, log ou commit.
- Se não achar um caminho em 15 minutos, pare e relate o que descobriu.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- O caminho escolhido no envio e por quê.
- O resultado de `npm run typecheck` e do teste.
- O que não conferiu.
