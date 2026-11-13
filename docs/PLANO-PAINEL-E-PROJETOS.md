# Plano — painel no celular, vários projetos e projetos por SSH

Criado em 11/11/2026, branch `task/personal-activation`. Este é o roteiro até o fim. Siga as fases em ordem e não pule nenhuma.

Quem faz: o Grok programa, um passo por vez, com a ordem em `docs/ORDEM-GROK.md`; o Claude é gerente e revisor (veja `AGENTS.md`).

## Onde paramos

Atualize esta tabela a cada commit.

| Fase | Assunto | Estado |
|---|---|---|
| 0 | Fechar o que já existe | limpeza feita (`76011327`, `0c6337a3`, `9d5284e7`, revisada e no ar); falta o teste no celular e um pedido real, que fica junto da prova da Fase 1 |
| 1 | Conversar pelo painel | **pronta e provada** pelo celular simulado no endereço público: pergunta, pedido → proposta → Aprovar → integrado no IspAgent (`4e71540`), Parar com confirmação. Commits `db24662b`…`5f3657fb`. Pendência pequena: o painel tenta o WebSocket `/api/v1/ws` e recebe 403 (ruído no console) |
| 2 | Vários projetos numa instalação | **pronta e provada**: `--add` acrescentou o repositório "segundo" à instalação do IspAgent (sem banco nem login novos); os dois pedidos rodaram ao mesmo tempo na mesma conta Grok e Claude, cada um integrado só no próprio repositório (IspAgent `12a0f09`, segundo `cf46f54`). Commits `c2845797`, `3836cc60`, `b2910a31` |
| 3 | Novo projeto pelo painel | **pronta e provada**: projeto criado pela tela no celular simulado (pasta liberada `workspace`), gateway reiniciou sozinho e um pedido nele integrou `cb119fb`. A falha anterior foi o limite de uso da assinatura Claude naquele momento. Commits `a4a8462c`…`802e74cb`, correções `4dc9c82b`, `0d787374` |
| 4 | Projeto em outro servidor por SSH | **pronta e provada** com servidor SSH de teste (contêiner local): identidade conferida e fixada, pastas remotas listadas, `..` recusado, projeto criado como cópia local, pedido integrado e enviado ao branch `agent-control/20261111-2344-6788309` do servidor (main intacto); identidade trocada recusada. Commits `b8e9d8e0`…`217488cc`. Falta só o titular testar com um servidor real dele |
| 5 | QA que roda os testes do projeto | **pronta e provada** no IspAgent: preparo com rede (pnpm, dependências no cache do QA) e 51 testes da API sem rede. Pedido que quebra teste foi reprovado com o teste na conversa; pedido normal passou e integrou `aa1d5e3`. Correções no caminho: `b578d741`, `eb546e78`, `3f11f029` |
| 6 | Avisos no celular e entrada sem o app Happier | código pronto e no ar (`37e1d090`…`02573d12`, correção `6d97d47d`); entrada por código provada no endereço público (válido entra, errado e reuso recusados, limite por endereço). **Falta o titular:** ativar os avisos no celular e tocar em "Enviar teste" |
| 7 | Fechamento | **feita**: revisão independente sem achado alto, 12 achados médios e baixos corrigidos (`bda6ba69`, `0e4f6a89`, `17310d60`); backup real (`personal:backup`, 292 MB) e restauração conferida num banco descartável; serviços derrubados e religados voltaram sozinhos e responderam; reinício real da máquina e push ficam com o titular |

Último commit conferido: `3f11f029`. Plano concluído; restam só as ações do titular.

## Aonde queremos chegar

Um endereço só, aberto no celular como app, onde o titular:

- vê e troca entre todos os seus projetos, deste servidor ou de outro servidor por SSH;
- cria um projeto novo escolhendo a pasta;
- conversa com o gerente, aprova, descarta ou para;
- vê o trabalho de cada papel (gerente, programador, QA e revisor), com o modelo usado;
- recebe aviso no celular quando há algo para decidir ou terminar.

Tudo isso com um único login de Claude e um de Grok para todos os projetos.

## Decisões já tomadas

Não reabra estas decisões sem um motivo novo.

1. **O painel Cezar é a interface principal.** O Happier continua por trás: guarda a conversa cifrada, faz o login e, até a Fase 6, envia os avisos. O app Happier vira opcional.
2. **Uma instalação, vários projetos.** O gateway (`src/projects-api.ts`, `config.projects`) e a página do Cezar já foram feitos para vários projetos. Hoje só o projeto principal executa. Com uma instalação só, os logins, o banco, o Happier e o endereço passam a ser comuns. Isso resolve o login copiado que expira, descrito em `RELATORIO-FINAL-USO-PESSOAL.md`.
3. **Uma conversa por projeto, que é a mesma no painel e no app.** O painel escreve na mesma conversa do Happier que o app usa, e o caminho do pedido continua o de hoje (`accept` em `src/happier.ts`). Não se cria um segundo caminho de autoridade.
4. **Projeto remoto é uma cópia aqui, com SSH só para buscar e devolver.** A IA e os logins ficam neste servidor. A chave SSH fica com o gateway e nunca entra num worker. A identidade do servidor (fingerprint) é fixada na primeira conexão. O resultado volta num branch `agent-control/...` e nunca no branch principal do outro servidor.
5. **O código de laboratório do RF-51** (`src/remote-git.ts`, `src/remote-development.ts`) não é usado no modo pessoal. Ele aceita no máximo 64 KiB e foi feito para a bancada. Fica como está, para o modo bloqueado.
6. **O modo `locked` não muda.** Todo código novo só funciona com `activation:"personal"`.

## Regras fixas

- Não fazer push e não reescrever o histórico.
- Commits com `GIT_AUTHOR_NAME="Enok Tavares" GIT_AUTHOR_EMAIL="migration@localhost"` (o mesmo para o committer), terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nada de compra de créditos. Nenhum segredo (chave da conta Happier, logins, chave SSH) em commit, log ou mensagem.
- Serviços systemd novos ou alterados são instalados pelo titular (`npm run personal:services`).
- A página do Cezar é editada em `upstream/cezar/packages/web/src` e construída com `VITE_AGENT_CONTROL_MANAGED=1 npm --prefix upstream/cezar run build:web`, que gera `upstream/cezar/packages/cezar/web/dist`. O build fica fora do git: faça o commit só do código e reinicie o gateway (`systemctl --user restart agent-control-gateway-ispagent`) para servir a página nova.
- Revisão independente segue o `AGENTS.md`: Claude Sonnet 5.5, esforço médio, somente leitura, até 5 revisores. O revisor recebe o código, não a conclusão. Registre como "revisão independente por modelo Claude distinto".

## Testes: só o essencial

Cada fase tem:

1. **Uma prova real de ponta a ponta**, a do "Pronto quando", feita pelo celular ou pelo endereço público, com modelos reais.
2. **Poucos testes automáticos, só onde um erro seria grave**: acesso sem login, caminho fora da pasta permitida, servidor SSH com identidade trocada e um projeto escrevendo no repositório de outro.

Não escreva testes de tela, de texto ou de casos raros. Não rode a suíte completa a cada fase; rode só os testes dos arquivos alterados.

---

## Fase 0 — Fechar o que já existe (pequena)

- [ ] **Titular:** entrar no painel pelo celular ("Entrar pelo Happier", aprovar no app) e instalar como app. Se falhar, corrigir com o print.
- [ ] Um pedido real no IspAgent, para confirmar que a tarefa mostra o relato de cada papel com o modelo (`src/personal-team-feed.ts`, `stageReport`).
- [ ] Tirar do painel o que engana:
  - a dica "claude --resume" de assumir a sessão;
  - o seletor de modelo claude/opus;
  - os erros 403 de star-count, agent-profiles e skills-update. O gateway passa a responder vazio, como já faz com os registros de leitura em `src/api.ts`.

**Pronto quando:** o painel abre no celular como app, já logado, e uma execução nova mostra o relato de cada papel.

## Fase 1 — Conversar pelo painel

1. [ ] **Ler a conversa:** `GET /api/v1/ac/personal/conversation?projectId=…&after=…` no gateway. Devolve as mensagens decifradas do projeto (titular, gerente e equipe), em páginas, usando a mesma chave e a mesma recuperação de histórico da ponte (`recoverHistory` em `src/happier.ts`). Só no modo pessoal e só com login.
2. [ ] **Enviar mensagem:** `POST /api/v1/ac/personal/messages {projectId,text,clientId}`. Grava o texto como mensagem do titular na conversa do Happier do projeto e a ponte processa como hoje. `clientId` evita mensagem duplicada quando o celular reenvia.
   - **Se o Happier não aceitar a gravação pelo gateway:** chamar o `accept()` do transporte do projeto e espelhar o texto na conversa. Registre aqui qual caminho ficou.
3. [ ] **Tela "Conversa" no painel:** lista de mensagens com atualização a cada 2–3 s e caixa de texto. Ela substitui o aviso "canonical-happier-conversation" de `upstream/cezar/packages/web/src/components/composer/composer.tsx` e a caixa "Continue" que não funciona.
4. [ ] **Botões Aprovar, Descartar, Parar e Equipe**, que enviam as palavras de controle de hoje (`src/personal-conversation.ts`). Não se cria nenhum caminho novo de autoridade.
5. [ ] **Proposta legível:** cartão com as tarefas e os arquivos da proposta pendente, usando os endpoints `manager-plans` que a página já conhece.
6. [ ] **"Nova tarefa" do Cezar** passa a abrir a conversa com o texto já preenchido.

**Testes essenciais:** um teste dos dois endpoints, cobrindo a recusa sem login, a recusa fora do modo pessoal e o `clientId` repetido sem duplicar.

**Pronto quando:** pelo app no celular, sem abrir o Happier, uma pergunta recebe resposta, um pedido gera proposta, Aprovar leva até a integração com o relato de cada papel e Parar cancela uma execução.

## Fase 2 — Vários projetos numa instalação (a maior)

1. [ ] **`composePersonalRuntime` (`src/personal-runtime.ts`) passa a ser por projeto.** Hoje ele usa `config.project.repo` em cerca de seis pontos.
   - Continuam comuns: imagens, rede dos workers, chaves de assinatura e pastas de contas.
   - Passam a ser por projeto: trava do repositório, artefatos Git, QA e implementação.
2. [ ] **`src/server-main.ts`:** tirar as condições `project.id===config.project.id` do modo pessoal (linhas ~174–179). Cada projeto de `projects[]` ganha execução, transporte do gerente e conversa com o gerente.
3. [ ] **Relatos da equipe e das etapas por projeto:** hoje `registerStageReporter` aceita um único repositório.
4. [ ] **Uma conversa do Happier por projeto**, na mesma conta (`src/personal-connect.ts`).
5. [ ] **Capacidade:**
   - contas comuns a todos os projetos;
   - políticas de capacidade e de qualidade por projeto;
   - um limite global de execuções simultâneas por conta, para não estourar a cota.
6. [ ] **`npm run personal:project -- --add <instalação.json> <repositório> --label x`:** acrescenta o projeto a uma instalação existente, sem banco novo e sem login novo. A lógica fica num módulo que a Fase 3 reaproveita.
7. [ ] **Seletor de projetos no painel:** a página do Cezar já lista projetos por `/api/v1/projects`. Cada projeto tem a própria conversa e as próprias tarefas.
8. [ ] **Migração, com backup do banco, do cofre e de `installation.json` antes:**
   - a instalação do IspAgent vira a principal;
   - a instalação de teste `smoke` fica de lado;
   - as sobras `smoke2` podem ser apagadas com o OK do titular.

**Testes essenciais:** um teste de isolamento: o worker de uma tarefa do projeto A só enxerga o repositório A e nunca escreve no B.

**Pronto quando:** o IspAgent e um segundo repositório local estão na mesma instalação. Um pedido em cada, ao mesmo tempo, pelo painel, é integrado no repositório certo, com um único login de Claude e um de Grok.

## Fase 3 — Novo projeto pelo painel (local)

1. [ ] **Navegar nas pastas:** `GET /api/v1/ac/personal/folders?path=…` lista subpastas só dentro das raízes permitidas (`projectRoots`) e marca quais são repositórios Git. Não segue link simbólico e recusa `..`.
2. [ ] **Criar o projeto:** `POST /api/v1/ac/personal/projects {path,label}` faz o mesmo que o `--add` da Fase 2, com o mesmo módulo. Só aceita repositório Git com um branch. Se a pasta não for Git, explica como resolver.
3. [ ] **Tela "Novo projeto":** navegar, escolher a pasta, dar um nome, criar e cair na conversa do projeto.
4. [ ] **Arquivar projeto pelo painel:** some da lista e não apaga nenhum arquivo.

**Testes essenciais:** um teste de caminho, que recusa pasta fora das raízes, `..` e link simbólico que aponta para fora.

**Pronto quando:** pelo celular, escolho uma pasta do servidor, crio o projeto e faço um pedido nele.

## Fase 4 — Projeto em outro servidor por SSH

1. [ ] **Chave SSH da instalação:** gerar uma chave própria em `<dataDirectory>/ssh/` (ed25519). Ela não é a do usuário e pode ser revogada sozinha. O painel mostra a chave pública para o titular pôr no `authorized_keys` do outro servidor.
2. [ ] **Cadastrar o servidor:**
   - o titular informa host, porta e usuário;
   - na primeira conexão o painel mostra a identidade (fingerprint) e o titular confirma;
   - a identidade fica num `known_hosts` da instalação;
   - se a identidade mudar depois, o servidor é bloqueado e não há aceite automático.
3. [ ] **Navegar nas pastas remotas:** comando fixo pelo SSH, com o caminho validado e passado como argumento. O usuário nunca monta o comando. Mostra quais pastas são repositórios Git.
4. [ ] **Criar o projeto remoto:**
   - `git clone` por SSH para `<dataDirectory>/remote/<label>`;
   - o projeto guarda de onde veio;
   - a partir daí funciona como um projeto local, com o mecanismo das Fases 2 e 3.
5. [ ] **Antes de cada pedido:** `git fetch` do servidor remoto, para trabalhar sobre a versão atual do branch alvo.
6. [ ] **Devolver o resultado:**
   - depois da integração, `git push` para `refs/heads/agent-control/<data>-<tarefa>` no servidor remoto;
   - a conversa informa o branch e como juntar lá;
   - o branch principal do remoto nunca é tocado;
   - se a conexão cair, o mesmo push é refeito (é seguro repetir), sem refazer o trabalho.
7. [ ] **Opcional, só se o titular pedir:** botão "aplicar no principal" que faz o push para o branch alvo, só em avanço direto (fast-forward) e com aprovação explícita.

**Testes essenciais:**

- a identidade trocada do servidor é recusada;
- a chave SSH não aparece em nenhum worker (conferir as montagens do contêiner);
- o push só aceita `refs/heads/agent-control/*`.

**Pronto quando:** um repositório que só existe em outro servidor recebe uma mudança pedida pelo celular. O branch `agent-control/...` aparece lá com o commit e o branch principal do remoto continua igual. Primeiro com um servidor SSH de teste em contêiner aqui; depois com um servidor real do titular.

**Titular:** informar o servidor (host, porta, usuário, pasta) e autorizar a chave pública lá.

## Fase 5 — QA que roda os testes do projeto

1. [ ] **Configuração por projeto, no painel:** "comando de preparo" (por exemplo `npm ci`) e "comando de teste" (por exemplo `npm test`). Hoje o QA só confere conflito, JSON e sintaxe de JavaScript.
2. [ ] **O QA roda os dois comandos no contêiner de QA**, com cache de dependências por projeto, limite de tempo e as últimas linhas do erro na conversa.
3. [ ] **Projeto sem comando configurado continua com o QA de hoje.**

**Pronto quando:** no IspAgent, um pedido que quebra um teste é reprovado pelo QA, com o teste que falhou na conversa, e um pedido normal passa.

## Fase 6 — Avisos no celular e entrada sem o app Happier

1. [ ] **Service worker e Web Push:**
   - chaves VAPID da instalação em `<dataDirectory>`;
   - cada aparelho se inscreve uma vez;
   - o service worker não guarda respostas da API, para não mostrar dado velho.
2. [ ] **Quando avisar:** proposta pronta, execução integrada, falha e pergunta do gerente. Tocar no aviso abre a conversa certa.
3. [ ] **Entrada sem o app Happier:** um código de uso único, gerado por `npm run gateway -- pair <instalação.json>`, autoriza um aparelho novo. "Entrar pelo Happier" continua disponível.
4. [ ] **Avisos do Happier:** passam a ser opcionais, ligados ou desligados por instalação.

**Pronto quando:** com o celular bloqueado, chega "Proposta pronta" e o toque abre a conversa do projeto certo. Um aparelho novo entra com o código, sem o app Happier. No iPhone, o aviso só funciona com o painel instalado como app (iOS 16.4 ou mais novo).

## Fase 7 — Fechamento

1. [ ] **Revisão independente** do que é novo (endpoints, pastas, SSH, push e avisos), seguindo o `AGENTS.md`, e correção dos achados graves.
2. [ ] **Backup:**
   - `npm run personal:backup` salva a chave Happier, o cofre, o banco e as chaves SSH e VAPID;
   - testar uma restauração numa instalação descartável.
3. [ ] **Reinício do servidor:** confirmar que os serviços voltam sozinhos e o painel responde.
4. [ ] **Atualizar os documentos:** `docs/USO-PESSOAL.md` (como usar), `docs/RELATORIO-FINAL-USO-PESSOAL.md` (o que foi provado) e esta tabela.
5. [ ] **Titular:** decidir o push do branch.

**Pronto quando:** não resta achado grave, o backup foi restaurado num teste e os serviços voltam sozinhos depois de reiniciar o servidor.

---

## Fora deste plano

Itens deixados de fora de propósito:

- Editar direto na pasta do outro servidor (RF-39). A cópia central da Fase 4 cobre o uso pessoal.
- Vários usuários ou equipes no mesmo painel.
- Homologação, modo `locked` e os itens antigos da matriz.
- Paseo e automações do Grok sem supervisão.
- Provedores além de Claude e Grok. Dá para acrescentar depois pelo mesmo cadastro de contas.

## Riscos conhecidos

| Risco | Como tratar |
|---|---|
| A Fase 2 mexe no centro do runtime | Fazer em passos pequenos, provando o IspAgent sozinho antes de pôr o segundo projeto. Backup antes da migração. |
| Uma atualização do Cezar pode quebrar a página | As mudanças ficam em arquivos próprios e poucos pontos de ligação. Conferir o painel depois de qualquer atualização do `upstream/cezar`. |
| Cota compartilhada entre projetos | Limite global por conta (Fase 2.5) e fila em vez de erro. |
| Conexão SSH cai no meio | O push é seguro de repetir. A execução não depende da conexão, porque roda aqui. |
| Web Push no iPhone é limitado | Exige o app instalado. Enquanto isso, o app Happier continua avisando. |

## Melhorias depois do plano (pedidas em 12/11/2026)

| # | Melhoria | Estado |
|---|---|---|
| M1 | Cara própria do painel (nome, cor, menu enxuto) e fim dos avisos que poluem | **feita** (`7d4da904`…`f007429c`), conferida no celular simulado, zero erros no console; restam palavras em inglês na lista lateral do Cezar |
| M2 | QA com os testes que usam banco | **feita e provada**: banco PostgreSQL temporário numa rede interna sem internet a cada QA; suíte completa da API do IspAgent (369 testes) passou e o pedido integrou `dcbcd5a`, sem sobras. Correções no caminho: OpenSSL na imagem (`6cdbc57c`), banco preservado até o fim do job (`bb0d98ab`), um só caminho inicia o teste (`a1febba2`) |
| M3 | Corrigir os testes antigos | **feita**: simulações de teste atualizadas, só em `tests/`; 5 arquivos, 17 testes passam (merge `b205b0e5`). Ficam de fora os que pedem ambiente inexistente aqui (controlador isolado, bancos R3) |
| M4 | Tirar o Happier | **feita e provada** no IspAgent: transporte local (`managerTransport.transport="local"`, merge `592725e3`), histórico de 1.994 mensagens importado com datas originais (`9e398027`), login só por usuário e senha, serviço `agent-control-happier-ispagent` desligado; pedido completo integrado `a569380`. Volta atrás: tirar o campo, religar o serviço e reiniciar o gateway |

## Acabamento (13/11/2026)

| Item | Estado |
|---|---|
| Vigia a cada 2 min (aviso de queda e volta, imagens refeitas sozinhas) | **feito e provado** com queda simulada; timers `agent-control-watch-ispagent` e `agent-control-backup-ispagent` ligados |
| Backup diário 03:30, 7 cópias, cópia externa opcional (`<dataDirectory>/backup-offsite`) | **feito**; falta o titular informar o destino externo |
| Cota do Claude: espera e retoma sozinho | **feito** e coberto por testes; não aconteceu ao vivo ainda |
| Conversa limpa (avisos repetidos escondidos, iguais em 10 min suprimidos) | **feito e provado** |
| Lista de tarefas e menu em português, QA pelo painel | **feito**; a página de Configurações ainda tem textos do Cezar em inglês |
| Instalação `smoke` desligada | **feito** (dados mantidos) |
