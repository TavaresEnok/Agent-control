# F0 — Pacote D: percurso móvel parcial na base Aixle

**G0: PENDENTE.** Esta entrega mede componentes reais no Chromium com transporte e dados sintéticos. Não aprova percurso autenticado integrado, persistência, deduplicação no backend, perfil de conta/modelo ou execução Temporal. Revisão independente é a próxima fase.

Base: Aixle Flow `e6ec5a286120aed3a036d85871e796b2f6c97d70`, conforme `UPSTREAM.json`; árvore de desenvolvimento anterior à entrega: `4bb591f73a17d9d9c3a6f208b6dcdd38bd92eb6b`. Referências: Plano Mestre v1.1 §19.3/Pacote D, G0-E5 de `F0-CHECKLIST.md`, EV-05 de `F0-EVIDENCIAS.md`, ADR-001 e Adendo Final §4–5. `.paseo-context.md` não existe nesta worktree; o contrato recebido e `docs/PASEO-CONTINUACAO.md` orientaram a execução.

## Superfície reutilizada e fronteiras

Todos os caminhos abaixo são relativos à raiz; os componentes são importados diretamente, sem cópia e sem alteração em `app/`.

| Percurso / rota da base | Componente / implementação | O que foi medido ou falta |
|---|---|---|
| `/company/projects/:project_id/agents` | `app/frontend/shared/resources/agents/AgentFormModal.tsx`; `Web::Company::Projects::AgentsController` | Formulário real, validação, envio e preservação de campos após falha sintética. É **agente/persona**, não perfil RF-55 de conta/modelo. Persistência não executada. |
| `/company/projects/:project_id/board`; POST `/api/v1/projects/:project_id/tasks` | `pages/Projects/Board/BoardPage.tsx`, `TaskCardUI.tsx`; `Api::V1::Projects::Board::TasksController`, `TaskService.create` | Cartão real com uma tarefa sintética. O formulário de criação está acoplado ao `BoardPage` e **não foi extraído nem reimplementado**. Criação de tarefa: NOT RUN. |
| `/company/projects/:project_id/workflow_runs/:id` | `pages/Projects/WorkflowRuns/ShowPage.tsx`, `pages/Projects/Board/RunStepTimeline.tsx` | Timeline real: expansão/recolhimento de quatro etapas sintéticas. Página completa, ações e estados vindos do Temporal: NOT RUN. |
| `/company/projects/:project_id/workflows/:id/builder` | `pages/Projects/Workflows/SessionTreeNav.tsx`, `StepEditorPanel.tsx`, `SessionEditorPanel.tsx` | Árvore real em leitura: `ROOT`, dependência `AFTER Implementation` e seleção de sessão. É representação de dependências, não prova de canvas/grafo Temporal nem configuração persistida por etapas. Editores apenas identificados. |
| `/cable` e refresh Inertia | `shared/lib/hooks/useInertiaCableStream.ts`, `shared/lib/actionCableConsumer.ts` | Cliente ActionCable real, confirmação de assinatura e reconexão reais no browser; mensagens de servidor e snapshot fornecidos pelo Playwright. |

As rotas estão em `config/routes/web.rb`. Na base, `Web::Company::ApplicationController` exige autenticação, associação ativa e autorização; a API exige autenticação e CSRF; `ApplicationCable::Connection` rejeita usuário não verificado. **Inspeção não prova proteção em execução**. O harness não monta Rails nem simula uma aprovação dessas fronteiras.

`AgentFormModal` usa `submitting` para indicar envio e volta a permitir tentativa após `onError`. O ensaio observa dois payloads iguais, sem chave de comando. Isso não demonstra duas linhas persistidas: por exemplo, validação de nome único pode recusar a repetição, mas tampouco comprova resposta idempotente ao mesmo comando.

No caminho de tarefa inspecionado, `BoardPage.handleCreateTask` envia atributos de `boardTask`; o controller permite esses atributos e `TaskService.create` constrói uma nova tarefa e registra o evento de auto-trigger transacionalmente. Não foi encontrada uma chave de comando nesse caminho delimitado. Já `WorkflowService.enqueue` **aceita** `idempotency_key` e o banco tem índice único parcial `(user_id, idempotency_key)` em `workflow_runs`; o `WorkflowRunsController#create` web inspecionado não fornece essa chave. Deduplicação existente de workflows/webhooks não pode ser transferida por presunção ao reenvio móvel de criação de tarefa/agente. Nada disso foi testado contra banco nesta entrega.

## Reprodução isolada

Executar na worktree desta tarefa, sem serviços existentes, contas reais ou IA:

```sh
python3 tools/f0/mobile/preflight.py
python3 tools/f0/mobile/setup.py
# Apenas se o preflight indicar bibliotecas ausentes, em Debian 12 x86_64:
python3 tools/f0/mobile/browser-libs.py
python3 tools/f0/mobile/run.py
git diff --check
```

`setup.py` baixa Node `22.16.0` com SHA-256 conferido contra o manifesto oficial, instala dependências pelo lockfile local e Chromium headless pelo Playwright `1.61.1`. Não depende do Node do host. O subconjunto de dependências frontend usa versões fixas compatíveis com o manifesto da base; o lockfile não substitui o `yarn.lock` do produto.

`browser-libs.py` baixa pacotes Debian com índices assinados e extrai os `.deb` dentro de `tools/f0/mobile/.runtime`; não instala pacotes, executa scripts de manutenção ou inicia serviços. Configuração/listas/cache/logs APT e temporários ficam nessa pasta. O runner define busca local de bibliotecas e fontes. Não há sudo. Pacotes do sistema podem evoluir: nomes/versões/hashes dos arquivos usados ficam no relatório para auditoria; não se promete igualdade binária entre datas diferentes.

O Vite serve **somente o harness de prova**, em `127.0.0.1` e porta efêmera, sem carregar configuração ou `.env` do produto. Ele encerra ao terminar. O browser bloqueia requisições HTTP fora dessa origem. Não há dispatcher, motor, API de produto ou persistência paralelos. Apenas `router.post` e `router.reload` são substituídos no harness por requisições a `/__f0/*`; o Playwright responde a essas requisições e ao protocolo `/cable`. A autenticação, o servidor ActionCable e o adapter Inertia/Rails não são exercitados. A casca do harness fornece espaçamento e algumas variáveis de cor; não reproduz todo o layout/tema/navegação do produto.

Roteiro automático executável em `test/f0/mobile/browser.mjs`:

1. Abrir o formulário real, rejeitar campos vazios sem envio e preencher uma persona sintética.
2. Abortar a primeira confirmação de transporte; verificar erro e campos preservados. Reenviar e comparar os dois payloads capturados, sem atribuir deduplicação ao backend.
3. Exibir uma tarefa sintética no cartão real; expandir/recolher etapas e selecionar a sessão dependente na árvore real.
4. Fechar o WebSocket sintético, mudar o snapshot durante a desconexão e confirmar nova assinatura, uma leitura de snapshot e cartão passando de `Running` a `Succeeded` pelo hook real.
5. Medir largura do documento em 390×844 e 360×844; registrar capturas, trace e hashes.

## Execução e limites de aceite

O runner agora usa uma pasta exclusiva por execução em `tools/f0/mobile/artifacts/` e exporta os bytes para `docs/validation/artifacts/mobile/<startedAt>/` **antes de fechar browser e harness**. O destino é versionável e sobrevive ao cleanup quando integrado pelo controlador. Não basta conservar a cópia ignorada. Cada pacote contém `report.json`, `trace.zip`, quatro capturas essenciais e `manifest-sha256.json`; em falha, retém os artefatos disponíveis sem promover o resultado a PASS. Não se misturam bytes de execuções anteriores.

O relatório registra comando, exit code, commit base (o código de trabalho é identificado pelos hashes), versões Node/browser/dependências do lockfile, cenários, hashes dos 19 módulos reais e dos scripts/configurações do ensaio, payloads sintéticos, reconexão e medidas. O exportador verifica JSON, integridade ZIP, presença de eventos do trace, assinaturas PNG, hashes das capturas e, para resultado completo, quatro checks parciais, 19 módulos, zero pageerrors e ausência de overflow em 390/360. Falhas geram exit code não zero. HTTP e WebSocket externos são bloqueados; usam-se somente identidades sintéticas. Não se exportam env, runtime, Chromium ou node_modules. Caminhos absolutos da worktree são substituídos por `/worktree` no relatório e nas entradas textuais do trace; os hashes novos se referem aos bytes exportados.

Conferência independente do pacote retido, sem browser, rede ou dependências externas:

```sh
python3 tools/f0/mobile/evidence.py verify docs/validation/artifacts/mobile/<startedAt>
```

Execução final: **2026-10-31 14:40:17–14:40:43 UTC**, Node `v22.16.0`, Chromium `149.0.7827.55`, exit code **0**, quatro checks parciais PASS e zero erros JavaScript capturados. Observados: dois envios idênticos do formulário; duas conexões WebSocket; uma leitura de snapshot após reconexão; cartão `Running` → `Succeeded`. A largura do documento foi respectivamente 390 e 360 px, sem overflow horizontal nas duas medições finais. Isso não inclui medição de teclado virtual ou de todas as telas.

O preflight inicial encontrou Node e Ruby ausentes no PATH. A primeira transferência do navegador excedeu o `/tmp` de 128 MB; o bootstrap passou a usar `.runtime/tmp`. O primeiro launch acusou bibliotecas compartilhadas ausentes; a extração local resolveu o preflight (`missing_browser_libraries: []`). Esses eram impedimentos de ambiente, não cota de provedor. A instalação permaneceu dentro da worktree.

Hashes SHA-256 históricos do lote1 (**bytes perdidos no cleanup, indisponíveis**; não identificam o novo pacote):

| Artefato em `tools/f0/mobile/artifacts/` | SHA-256 |
|---|---|
| `report.json` | `e81f03674ac7690e061552d9056c470f89a85e448e9c206d4d99555516e76438` |
| `trace.zip` | `8f74c6719b2ad4c283491e13bea3646ab6304b1e938a8286335485caa5139060` |
| `390-agent-lost-ack.png` | `d82fd36ddc08505e7c04ab1efee507f0ffac1f6cf6f06cdbf88fa01dd83174a3` |
| `390-running-dependencies.png` | `a7e53b33cdec7b6e15f045fe71bc1a271fe42089d7f1e57657685c00ce9f10f4` |
| `390-reconnected-completed.png` | `39c666e01b6a57fb31873be1b5ac8f219b43079386584e4eb19f6458d14c06f7` |
| `360-components.png` | `bec13fe73f6983e1a67280626852d60b1dc57f3e07968870422ae1c634c06fbf` |

O relatório histórico continha ainda hashes de 19 módulos carregados da base e dos 112 arquivos Debian extraídos (dependências transitivas/alternativas incluídas). Nova execução regenera horários, porta e trace; os hashes históricos acima não são usados como recibo da recuperação. Checks estáticos históricos essenciais: `git diff --check`, compilação sintática dos quatro scripts Python e `node --check` dos dois scripts JavaScript, todos com exit code 0.

### Recuperação dos bytes — lote3

Uma única reexecução do percurso existente: **2026-10-31 15:28:34.181–15:29:12.367 UTC**, comando `python3 tools/f0/mobile/run.py`, base `d49a2bc5704d71a5d4a10b07460470f1ea6a8828`, Node `v22.16.0`, Chromium `149.0.7827.55`, exit **0**. Quatro checks **PASS parcial**, 19 módulos reais identificados por hash, dois payloads sintéticos iguais, duas conexões ActionCable e uma leitura de snapshot; `errors: []`, largura 390/360 igual aos viewports, sem overflow. Não houve segunda matriz ou reexecução SQL/Temporal.

Pacote retido: [2026-10-31T152834-181Z](artifacts/mobile/2026-10-31T152834-181Z/) (~7,6 MB). O [manifesto SHA-256](artifacts/mobile/2026-10-31T152834-181Z/manifest-sha256.json) enumera todos os bytes. As capturas foram inspecionadas visualmente. Alguns PNGs são idênticos aos históricos por renderização determinística; isso não recupera os bytes perdidos nem reaproveita o recibo antigo.

| Novo artefato | SHA-256 |
|---|---|
| `report.json` | `52063c8f155a70d6aab68bc28bef3866f7ce8389a1b89719aeb424d9e1e7b697` |
| `trace.zip` | `af21d1dff07cd4320a766a79c1459ca86bcf872d4c6faaf2423803cdd4f2647f` |
| `390-agent-lost-ack.png` | `d82fd36ddc08505e7c04ab1efee507f0ffac1f6cf6f06cdbf88fa01dd83174a3` |
| `390-running-dependencies.png` | `ad426cd58adf22d8c69a103a8b9292d84659ada5f379e1c1ce4a1d529e459a15` |
| `390-reconnected-completed.png` | `39c666e01b6a57fb31873be1b5ac8f219b43079386584e4eb19f6458d14c06f7` |
| `360-components.png` | `bec13fe73f6983e1a67280626852d60b1dc57f3e07968870422ae1c634c06fbf` |

O trace inclui o WebSocket de HMR do próprio Vite, na mesma origem efêmera isolada, além do `/cable` sintético. O parâmetro de HMR é gerado por esse harness local; não é token de sessão de conta real. A auditoria dirigida verifica origem/porta HTTP/WS e ausência de cookies, Authorization e CSRF nas requisições gravadas, caminhos sanitizados, hashes do código executado e rejeição de relatório adulterado. Para repetir somente a auditoria dos bytes, sem novo browser:

```sh
python3 tools/f0/mobile/evidence.py verify docs/validation/artifacts/mobile/2026-10-31T152834-181Z
python3 test/f0/mobile/retention_test.py
git diff --check
```

O pacote está em caminho não ignorado e precisa ser incluído na integração pelo controlador antes da remoção desta worktree. Nenhum commit foi feito pelo executor. **G0 segue PENDENTE; revisão independente segue como próxima fase.**

| Critério | Resultado desta entrega |
|---|---|
| Formulário real de agente, erro e reenvio sintético | PASS parcial; sem conta/modelo ou persistência. |
| Tarefa / estados / etapas / dependências | PASS parcial dos componentes com fixture; criação e grafo de execução integrado NOT RUN. |
| Reconexão | PASS parcial do cliente/hook com transporte sintético; backend durável NOT RUN. |
| Mobile | Medição em viewport emulado; aparelho físico, teclado virtual, shell completo e navegação autenticada NOT RUN. |
| Auth / autorização / CSRF / UI–API–WS | NOT RUN: sem runtime Rails/DB isolado; Ruby ausente no PATH. Não foram usados cookies ou serviços existentes. |
| Deduplicação backend / Temporal | NOT RUN: sem banco/worker/Temporal isolados; duas tentativas de transporte não são prova de efeito persistido único. |

Não foi executado `make setup`/`make up`: o README informa que sobem web, worker, banco, Redis, Traefik e Temporal; os defaults não constituem isolamento aprovado para este ensaio. Uma próxima fatia integrada exige projeto de serviços efêmeros, portas/volumes/redes exclusivos, usuários de teste e runtime sintético elegível, antes de abrir as rotas reais. Nenhuma conta de IA é necessária para o harness atual.

Adaptações a levar ao backlog: perfil versionado de conta/modelo separado de persona; chave estável de comando com resultado reapresentável no backend e propagação pela UI/API; criação móvel de tarefa e configuração de etapas exercitadas no shell real; grafo de leitura vinculado a runs e fronteiras autenticadas testadas. A árvore/timeline existentes oferecem reuso; não é necessário criar outra aplicação ou motor. Custo e priorização finais dependem da revisão independente e das demais provas F0/G0.
