# Ordem para o Grok — Fase 1, parte B: a tela "Conversa" no painel

Escrita pelo gerente (Claude) em 11/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço médio.

---

Você é o programador do Agent Control. O roteiro está em `docs/PLANO-PAINEL-E-PROJETOS.md`; leia "Fase 1". A parte A está pronta e foi provada com o Happier real:

- **`GET /api/v1/ac/personal/conversation?after=<cursor>&limit=<n>`** devolve `{messages:[{id,role:'owner'|'manager',text,createdAt}],next}`. Sem `after`, traz as mais recentes. Com `after=<next>`, traz só as novas.
- **`POST /api/v1/ac/personal/messages`** com `{text,clientId}` devolve `202 {id}`. O mesmo `clientId` nunca gera dois pedidos. O gerente responde na mesma conversa em alguns segundos; um pedido de mudança vira uma "Proposta de plano N" em texto.

Agora faça a tela. Tudo o que você mudar vale **só quando `import.meta.env.VITE_AGENT_CONTROL_MANAGED==='1'`**. Fora disso, o Cezar continua igual. O código está em `upstream/cezar/packages/web/src`.

## O que fazer

1. **Rota nova `/conversa`**, só no painel gerenciado, registrada em `routes.tsx`. Tela de conversa pensada primeiro para o celular:
   - **Mensagens:** lista com "Você" à direita e "Gerente" à esquerda, com a hora. Mostre as quebras de linha do texto; não interprete HTML.
   - **Atualização:** a cada 3 s, só com `after=<next>`. Pause quando a aba não está visível.
   - **Rolagem:** desce sozinha só se a pessoa já estava no fim.
   - **Caixa de texto e botão Enviar:** Enter envia; Shift+Enter quebra a linha.
     - Gere o `clientId` com `crypto.randomUUID()` sem hífens, um por mensagem.
     - Se o envio falhar por rede, o botão "Tentar de novo" reusa o **mesmo** `clientId`.
     - Mostre a mensagem enviada como "enviando…" até ela aparecer na leitura.
   - **Botões rápidos** acima da caixa: **Aprovar**, **Descartar**, **Parar** e **Equipe**. Eles enviam os textos `aprovar`, `descartar`, `pare` e `equipe`. **Descartar** e **Parar** pedem confirmação antes.
   - **Erros:** 401 leva ao login, como o resto da página. Outros erros aparecem numa linha discreta, sem travar a tela.

   Use os componentes e estilos que a página já tem (botões, campo de texto, cores do tema claro e escuro), e o mesmo jeito das outras chamadas `/api/v1/ac/...` da página (veja `components/auth/agent-control-auth-gate.tsx`).
2. **Navegação:**
   - acrescente "Conversa" no menu principal do painel gerenciado, também no celular, como primeiro item;
   - a página inicial do painel gerenciado (`/`) abre a Conversa;
   - a lista de tarefas continua acessível pelo menu.
3. **Caixa da tarefa:** em `components/composer/composer.tsx`, troque o aviso "A conversa oficial está no Happier" e o link `/api/v1/ac/runs/<id>/conversation` por um botão "Falar com o gerente", que leva a `/conversa`.
4. **"Nova tarefa":** no painel gerenciado, a tela de nova tarefa (`routes/new-task.tsx`) leva para `/conversa` com o texto digitado já na caixa. Pode ser por `?texto=`. A Conversa lê esse parâmetro uma vez e o limpa da URL.

## Testes

Não escreva testes de tela. Verificação:

- `npm --prefix upstream/cezar/packages/web run typecheck` sai 0;
- `npm run typecheck` sai 0.

O gerente faz o build, abre a página no celular simulado e faz a prova real.

## Permissões nesta execução (não tem tela)

- Você só pode editar arquivos em `upstream/cezar/packages/web/src/`, com suas ferramentas de arquivo.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `rg`, `ls`.
- Qualquer outro comando encerra a execução.

## Regras

- Sem push. Não toque em `docs/PROMPT-GROK-*.md` nem em `docs/PROXIMA-ORDEM.md`.
- Um commit por item (1, 2, 3 e 4). Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude. O autor já está no ambiente; não rode `git config`.
- Textos da tela em português, curtos.
- Se não achar um caminho em 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits e uma linha sobre cada um.
- O resultado dos dois typecheck.
- O que não conferiu.
