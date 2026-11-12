# Ordem para o Grok — Fase 6: avisos no celular e entrada sem o app Happier

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço médio.

---

Você é o programador do Agent Control. Leia `docs/PLANO-PAINEL-E-PROJETOS.md` ("Fase 6"). As Fases 1 a 5 estão provadas.

O painel é um PWA servido pelo gateway: `src/api.ts` injeta o manifest e os ícones, e `src/projects-api.ts` lista os caminhos públicos. Ainda não há service worker. O login de hoje é "Entrar pelo Happier": `upstream/cezar/packages/web/src/components/auth/agent-control-auth-gate.tsx`, as rotas `/api/v1/ac/auth/*` e `BrowserSessions`. O gerente já instalou `web-push@3.6.7` e `@types/web-push@3.6.4` no `package.json`.

## O que fazer

Tudo vale só no modo pessoal (`activation:'personal'`).

1. **Chaves e inscrições** (`src/personal-push.ts`).
   - Chaves VAPID da instalação, geradas uma vez com `webpush.generateVAPIDKeys()`, em `<dataDirectory>/push/vapid.json` (pasta 700, arquivo 600).
   - O `subject` é `mailto:` com um endereço genérico (`mailto:agent-control@localhost`), nunca o e-mail do titular.
   - Inscrições em `<dataDirectory>/push/subscriptions.json` (600): `[{id,endpoint,keys:{p256dh,auth},createdAt,label}]`, no máximo 20.
   - Uma inscrição que o serviço de push devolve com 404 ou 410 é apagada.
2. **Rotas** (só para o dono, no padrão das rotas `personal/*` de `src/api.ts`):
   - `GET /api/v1/ac/personal/push` devolve `{publicKey,subscriptions:[{id,label,createdAt}]}`;
   - `POST /api/v1/ac/personal/push/subscribe {subscription,label}` grava a inscrição;
   - `DELETE /api/v1/ac/personal/push/subscribe/:id` apaga;
   - `POST /api/v1/ac/personal/push/test` manda "Teste do Agent Control" para todos.
3. **Quando avisar** (`src/happier.ts`, no `say()` da ponte do modo pessoal, sem atrasar a conversa).
   - Avise quando o texto de uma mensagem do gerente:
     - começa com "Proposta de plano";
     - contém "execução concluída";
     - contém "falhou";
     - começa com "Atenção";
     - ou é a resposta a uma pergunta do titular.
   - Título: o nome do projeto. Corpo: a primeira linha, com até 140 caracteres. `url`: `/p/<projectId>/conversa`.
   - Envie de forma assíncrona. Falha de envio é registrada no log, sem quebrar nada. O mesmo `id` de mensagem nunca avisa duas vezes.
4. **Service worker** `/sw.js` (público, servido pelo gateway; acrescente em `src/projects-api.ts` e em `src/api.ts`, como o manifest).
   - Trata `push` (`showNotification` com título, corpo, ícone `/pwa/icon-192.png` e `data.url`) e `notificationclick` (foca uma aba aberta do painel ou abre `data.url`).
   - **Não guarda cache de nada**: sem `fetch` handler.
   - A página registra o service worker no painel gerenciado.
5. **Tela.** No painel gerenciado, na Conversa (um ícone de sino no topo) ou nas configurações:
   - um botão "Ativar avisos neste aparelho", que pede permissão, inscreve com a `publicKey` e grava;
   - "Desativar" e "Enviar teste";
   - no iPhone fora do app instalado (sem `display-mode: standalone`), mostre: "No iPhone, instale o painel na tela inicial para receber avisos."
6. **Entrada com código, sem o app Happier.**
   - `npm run gateway -- pair <instalação.json>` (em `src/server-main.ts`, junto dos outros comandos) gera um código de 8 caracteres, letras maiúsculas e números, sem 0/O/1/I.
   - Grava só o hash SHA-256, com validade de 10 minutos e uso único, em `<dataDirectory>/pair-codes.json` (600).
   - Imprime o código e a validade.
   - `POST /api/v1/ac/auth/code {code}`, rota pública: se o código valer, cria a sessão do navegador para o dono da instalação (`config.project.owner`), do mesmo jeito que o login pelo Happier cria, com o mesmo cookie.
   - Limite: 5 tentativas erradas por minuto no total. Depois disso, `429` por um minuto.
   - Na tela de login (`agent-control-auth-gate.tsx`), um link "Entrar com código", com um campo e o texto "Gere o código no servidor com npm run gateway -- pair <instalação.json>".

## Testes essenciais

- O código vale uma vez, expira e cai no limite de tentativas.
- O `sw.js` não tem `fetch` handler (teste o texto servido).
- A regra de "quando avisar" é uma função pura e tem um teste com os cinco casos e um caso que não avisa.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `src/`, `tests/`, `scripts/` e `upstream/cezar/packages/web/src/`, além de `docs/USO-PESSOAL.md`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `npx tsx --test <arquivo>`, `rg`, `ls`.
- Não rode o gateway, o build nem o Docker.
- O `package.json` e o `package-lock.json` já têm o `web-push`. Inclua os dois no primeiro commit.

## Regras

- Sem push. O modo `locked` não muda. Nenhum segredo (chave VAPID privada, código) em log.
- Um commit por item. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- O resultado dos typechecks e dos testes.
- O que não conferiu.
