# Verificação de design do painel

Data da execução: 2026-11-17. Alvo: o pacote `upstream/cezar/packages/web`, construído com `VITE_AGENT_CONTROL_MANAGED=1` e servido pelo gateway descartável a partir de `upstream/cezar/packages/cezar/web/dist`. Sessão sintética, projeto `Projeto sintético`, sem dado pessoal e sem segredo nestas capturas. As três páginas pretas da rodada 1 foram apagadas.

## Build

Comando, no worktree, com saída 0:

`VITE_AGENT_CONTROL_MANAGED=1 npm --prefix upstream/cezar run build:web`

O Vite 8.1.4 transformou 3739 módulos e terminou em 2,33 s. O aviso de chunk acima de 500 kB permanece; não é falha. Não houve erro de resolução. O import `@happier-dev/protocol` deixou de aparecer nu no JavaScript emitido. No bundle, o ramo managed está fixo: o documento ganha a classe `ac-managed` e o título `Agent Control`. O `vite.config.ts` não foi alterado. O `dist` ficou em `upstream/cezar/packages/cezar/web/dist`.

## Happier

`upstream/happier/node_modules` não existia, nem `packages/protocol/dist`. O helper `node scripts/link-happier-test-deps.mjs install <origem> /tmp/ac-design-happier-links.json` foi tentado primeiro no checkout do validador. Ele recusou com o erro literal `MISSING_SOURCE /home/app/projects/agent-control-validador/upstream/happier/apps/server/generated`. O mesmo helper, na origem `/home/app/projects/agent-control/upstream/happier`, criou os links do que faltava. Não houve cópia dos cerca de 4 GB nem de segredo. O manifesto ficou em `/tmp/ac-design-happier-links.json`, modo 0600.

Dois desses links apontavam o boundary de outro checkout. Foram retirados do manifesto e apagados antes do build, para não escrever por cima desse arquivo. `node scripts/build-happier-boundary.mjs` gravou `upstream/happier/node_modules/.agent-control-boundary.mjs` neste worktree: arquivo local, não symlink, 191108 bytes, com sourcemap ao lado.

## Servidor

A primeira escuta, na porta 33359, com o banco `ac_implementation_test_designpanel_c3afababe16a4c3ea575`, foi encerrada e esse banco foi apagado. As capturas desta página e o `runDesignModule` usaram outra instalação pessoal descartável, em `http://127.0.0.1:42539`, banco `ac_implementation_test_designgw_075f4d31662d45b4`, criado por `isolatedDatabase` em cima de `AC_TEST_DATABASE_URL`. O gateway (`src/server-main.ts serve`) não é o gateway vivo e entrega o `dist` pelo mesmo caminho de `publicUi`. O log de pronto foi `administration_ready`, com `executionEnabled` falso, `inferenceEnabled` falso e o bootstrap nativo desligado. A entrada foi usuário e senha sintéticos, gravados só no diretório privado da instalação. O processo e esse banco são apagados no fim da rodada.

O Chrome foi `/usr/bin/google-chrome`, página inteira, em 375×812, 768×1024 e 1440×900. O React montou: `#root` não ficou vazio.

## Telas

| Tela | Rota | Arquivos | O que aparece |
|---|---|---|---|
| Entrada | `/` | `login-375.png`, `login-768.png`, `login-1440.png` | Cartão Agent Control, campos Usuário e Senha, botão Entrar e o link Entrar com código. |
| Tarefas | `/p/<projeto>/tarefas` | `tarefas-375.png`, `tarefas-768.png`, `tarefas-1440.png` | Cabeçalho Tarefas, busca e a navegação Conversa, Tarefas, Equipe, Novo projeto e Configurações. A lista está vazia: a barra lateral diz Nenhuma tarefa ainda. Em 375 px o menu fica na gaveta e o botão de nova tarefa aparece. |
| Equipe | `/p/<projeto>/equipe` | `equipe-375.png`, `equipe-768.png`, `equipe-1440.png` | Título Equipe, combo atual nenhum, e a lista complexo, intermediário e economia, com gerente, revisor, programadores e QA. |
| Conversa | `/p/<projeto>/conversa` | `conversa-375.png`, `conversa-768.png`, `conversa-1440.png` | Estado vazio Nenhuma mensagem ainda, botões Aprovar, Descartar, Parar e Equipe, e o campo Mensagem para o gerente. |
| Ajustes | `/settings/global/appearance` | `ajustes-375.png`, `ajustes-768.png`, `ajustes-1440.png` | Aparência do projeto sintético: tema System, Light e Dark, acento Azul e Violet, densidade e largura de leitura. |
| Não encontrado | `/p/<projeto>/rota-inexistente` | `nao-encontrado-375.png`, `nao-encontrado-768.png`, `nao-encontrado-1440.png` | Page not found, o texto de que nada existe nesse endereço, e o botão Back to tasks. |
| Novo projeto | `/p/<projeto>/novo-projeto` | `novo-projeto-375.png`, `novo-projeto-768.png`, `novo-projeto-1440.png` | Neste servidor, a raiz Pastas sintéticas, a pasta exemplo-sintetico, o nome e o botão Criar. |

![Entrada em 375 px](design-painel/login-375.png)

![Entrada em 768 px](design-painel/login-768.png)

![Entrada em 1440 px](design-painel/login-1440.png)

![Tarefas em 375 px](design-painel/tarefas-375.png)

![Tarefas em 768 px](design-painel/tarefas-768.png)

![Tarefas em 1440 px](design-painel/tarefas-1440.png)

![Equipe em 375 px](design-painel/equipe-375.png)

![Equipe em 768 px](design-painel/equipe-768.png)

![Equipe em 1440 px](design-painel/equipe-1440.png)

![Conversa em 375 px](design-painel/conversa-375.png)

![Conversa em 768 px](design-painel/conversa-768.png)

![Conversa em 1440 px](design-painel/conversa-1440.png)

![Ajustes em 375 px](design-painel/ajustes-375.png)

![Ajustes em 768 px](design-painel/ajustes-768.png)

![Ajustes em 1440 px](design-painel/ajustes-1440.png)

![Não encontrado em 375 px](design-painel/nao-encontrado-375.png)

![Não encontrado em 768 px](design-painel/nao-encontrado-768.png)

![Não encontrado em 1440 px](design-painel/nao-encontrado-1440.png)

![Novo projeto em 375 px](design-painel/novo-projeto-375.png)

![Novo projeto em 768 px](design-painel/novo-projeto-768.png)

![Novo projeto em 1440 px](design-painel/novo-projeto-1440.png)

## Módulo sobre este build

`npm run personal:design` rodou contra `http://127.0.0.1:42539`, numa instalação pessoal separada da do gateway, com o runtime nativo ativo. O gateway que serve o painel ficou sem bootstrap nativo. Execução `331663e8-79e1-4408-acee-ba9bf51eb9dc`, diretório `20261117-194844-design`, cerca de 48 minutos. O examinador foi Claude `claude-sonnet-5-5` (20 chamadas nativas, duas por tela: a primeira resposta nem sempre era um único objeto JSON). O revisor foi Codex `gpt-6.1-sol` (91 chamadas), outro provedor. A cadeia de especialista existiu só nesta instalação descartável, revisão de política 2, regular Claude e emergência Grok. O combo de fábrica não foi alterado.

O módulo gravou 24 capturas: oito rotas descobertas no código, em 375, 768 e 1440, tema claro, estado padrão. Não houve tema escuro nem estados forçados. As rotas saem do fonte como `/conversa`, `/novo-projeto`, `/new` e `/tarefas`, e também com o parâmetro literal ainda escrito (`/p/:projectId`, `/tasks/:id`, `/tasks/:id/*`, `/equipe` na amostra que voltou JSON). `/conversa`, `/novo-projeto` e `/new` pintaram a casca do Agent Control. `/tarefas` em 375 px mostrou o cabeçalho Tarefas no tema escuro, com a área principal vazia. `/equipe`, `/p/:projectId` e `/tasks/:id` responderam o documento `{"error":"AUTH_REQUIRED"}`. As sete telas desta página foram abertas nas rotas reais `/p/<projeto>/...` e em Ajustes; o módulo não substitui `:projectId` pelo id do projeto, e Ajustes não entrou nas oito rotas capturadas.

O relatório tem 91 achados. A nota de falha conta só confirmado ou reaberto: 2 altos, 17 médios e 13 baixos. Os dois altos confirmados são a captura de `/tasks/:id/*` que mostra só o JSON `AUTH_REQUIRED`, e códigos técnicos crus como mensagem de erro. Um alto ficou provável: o cinza `--soft-foreground` (`#a3a3a3`) sobre fundo branco. O revisor descartou parte dos pontos, entre eles o inventário de oito cinzas quando o achado não trouxe medida. Não há dado pessoal nem segredo no relatório.
