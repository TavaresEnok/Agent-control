# Ordem para o Grok — melhoria 1: cara própria do painel e fim dos avisos que poluem

Escrita pelo gerente (Claude) em 12/11/2026. O gerente executa o Grok sem tela, com `grok-4.7`, esforço médio.

---

Você é o programador do Agent Control. O painel é a página web do Cezar (`upstream/cezar/packages/web/src`) com as telas do Agent Control por cima. Tudo o que você mudar vale **só quando `import.meta.env.VITE_AGENT_CONTROL_MANAGED==='1'`**. Fora disso, o Cezar continua igual.

## O que fazer

1. **Nome e marca.** No painel gerenciado, o nome visível é sempre "Agent Control": título da aba, topo do menu, tela de entrada e qualquer "Cezar" visível ao usuário. O texto de licença e de créditos pode continuar.
2. **Cor própria.** Troque o acento verde-limão por um azul próprio (`#4F8CFF`, com texto escuro `#0B1220` sobre o botão), usando os tokens de `styles/index.css` (`--primary`, `--primary-foreground` e os de foco e anel). Faça isso num seletor que só vale no painel gerenciado. Por exemplo, uma classe `ac-managed` no `<html>`, posta em `main.tsx` quando a variável for `'1'`. Confira o tema claro e o escuro. Ajuste também o `theme_color` do manifest em `src/api.ts`.
3. **Menu enxuto.**
   - No painel gerenciado, o menu mostra só, nesta ordem: **Conversa**, **Tarefas**, **Novo projeto** e **Configurações**.
   - Esconda Inbox, Git, GitHub, Tracker, Automations, Skills e Workflows do menu e da paleta de comandos.
   - Se alguém abrir uma dessas rotas direto, a página mostra "Não disponível no Agent Control" com um link para a Conversa.
   - Rótulos em português.
   - Nas Configurações, deixe só as seções do Agent Control (procure `agent-control-section` e `registry.tsx`) e as de aparência e tema.
4. **Sem aviso de falha durante o reinício.** Na Conversa (`routes/conversa.tsx`):
   - uma falha de leitura isolada não mostra nada;
   - a partir de 3 falhas seguidas aparece "Reconectando…", discreto;
   - "Não foi possível atualizar." só aparece depois de 30 s sem sucesso;
   - a primeira leitura bem-sucedida limpa tudo.
5. **Sem a conexão em tempo real recusada.**
   - No painel gerenciado, a página não abre o WebSocket `/api/v1/ws`, que o gateway recusa com 403 de propósito. Veja `app.tsx`, `GlobalEventsProvider` e onde a URL do WebSocket é montada.
   - As telas que dependiam dele continuam funcionando pela consulta periódica que já existe. Se alguma ficar sem atualização, use uma consulta a cada 5 s só nela.

## Verificação

- `npm --prefix upstream/cezar/packages/web run typecheck` sai 0.
- `npm run typecheck` sai 0.
- Sem testes de tela. O gerente confere no celular simulado.

## Permissões nesta execução (não tem tela)

- Você pode editar arquivos em `upstream/cezar/packages/web/src/` e em `src/api.ts`.
- No shell, só estes comandos, **um por chamada**, sem `&&`, `;`, `|` ou redirecionamento e **sem variáveis de ambiente na frente**: `git status`, `git diff`, `git add <arquivos>`, `git commit -m "..."`, `git log`, `git show`, `npm run typecheck`, `npm --prefix upstream/cezar/packages/web run typecheck`, `rg`, `ls`.
- Não pesquise na internet nem rode outros comandos. Se faltar informação, procure no código com `rg`.

## Regras

- Sem push. Um commit por item. Mensagem de commit: uma frase em inglês, sem linha `Co-Authored-By` do Claude.
- Se travar por mais de 15 minutos, pare e relate.

## Relatório final

- Os hashes dos commits.
- Os typechecks.
- O que não conferiu.
