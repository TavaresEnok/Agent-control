# Relatório — módulo 10, design e experiência de uso

Ramo `task/modulo-design`. A execução anterior parou com HTTP 402, sem commit. Os arquivos dos passos 1 a 8 já estavam no worktree e os testes deles passavam. Esta continuação não reescreveu esses arquivos. Entrou o encaixe (`src/design-collect.ts` e `src/design-module.ts`), a prova do painel, os commits e este relatório. Não houve push, merge nem reescrita de histórico. Não houve chamada de API paga. A instalação viva, o gateway, o banco `ac_ispagent` e o worktree do módulo 1 não foram alterados. Não há migração 101.

O modo `locked` não muda. `runDesignModule` recusa qualquer ativação que não seja `personal` com `PERSONAL_ACTIVATION_REQUIRED` (403), sem consultar o banco e sem gravar relatório.

## Passos e commits

| Passo | Commit | O que entrou |
|---|---|---|
| 1. Imagem, pin das ferramentas e tipos | `d037ff28` | `deploy/Dockerfile.design`, entrypoint, rede `design-homologation`, lockfile e `src/design-types.ts`, `src/design-image.ts` |
| 2. Descoberta e capturas | `4eaa97d8` | `src/design-discover.ts`, `src/design-capture.ts` |
| 3. Acessibilidade e teclado | `1e1f7587` | `src/design-a11y.ts`, `src/design-keyboard.ts` |
| 4. Inventário visual e Stylelint | `e2c0774c` | `src/design-inventory.ts`, `src/design-stylelint.ts` |
| 5. Lighthouse | `4d8f555f` | `src/design-lighthouse.ts` |
| 6. Lista, examinador e bancada | `5208727c` | `src/design-checklist.ts` (72 itens), `src/design-examine.ts`, `src/design-bench.ts` |
| 7. Relatório e marcação | `20b13b10` | `src/design-report.ts`, `src/design-mark.ts` |
| 8. Régua | `030da96a` | `tests/fixtures/design-lab/` e `tests/design-lab.test.ts` |
| 9. Encaixe | `85ae60bf` | `src/design-collect.ts`, `src/design-module.ts` |
| 10. Painel | `4d4b4d89` | `docs/validation/verificacao-design-painel.md` e três capturas |
| 11. Este relatório | commit deste arquivo | apaga `.grok-notas/` antes |

A imagem parte de `mcr.microsoft.com/playwright:v1.65.1-noble` no digest `sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579`, usuário `65532:65532`. As ferramentas pinadas são axe-core 4.14.1, `@axe-core/playwright` 4.14.0, pa11y 10.0.0, `@lhci/cli` 0.16.1, `@projectwallace/css-analyzer` 9.9.9 e Stylelint 18.0.0. O SHA-256 de `deploy/design-tools/package-lock.json` está em `deploy/design-tools.lock.json`: `5d5312c0fce660f436dc8292e939d7b8d89001b12cc9f50882c85a0c84c91ee9`.

`runDesignModule` recebe o projeto e a URL, junta os achados brutos no formato do módulo 1 e devolve achados confirmados por outro provedor. A senha de login não entra no relatório.

A régua cobre os oito defeitos plantados (contraste, botão sem nome, foco invisível, nove cinzas, espaçamento fora da grade de 4 px, estado vazio ausente, largura quebrada em 375 px, texto cortado) e duas telas limpas (`boa-inicio`, `boa-detalhe`).

## Testes e números

Uma vez, na árvore completa, antes dos commits:

- `npx tsc -p tsconfig.json --noEmit --pretty false`: saída só do aviso `NO_COLOR`/`FORCE_COLOR`, código 0. Nenhum erro em `src/design-*` nem em `tests/design-*`.
- `umask 022 && npm test` (`node scripts/test-ci.mjs`): código 1, cerca de 590 s. Resumo: `{"passed":184,"failed":["installation-readiness.test.ts","workflow-runtime-bootstrap.test.ts"], ...}` com 81 arquivos na lista de laboratório. Os 15 arquivos `tests/design-*.test.ts` passaram dentro dessa suíte e nenhum deles foi excluído:

```
ok design-a11y.test.ts 0s
ok design-capture.test.ts 1s
ok design-checklist.test.ts 1s
ok design-collect.test.ts 1s
ok design-discover.test.ts 1s
ok design-examine.test.ts 0s
ok design-image.test.ts 0s
ok design-inventory.test.ts 0s
ok design-keyboard.test.ts 0s
ok design-lab.test.ts 1s
ok design-lighthouse.test.ts 0s
ok design-mark.test.ts 0s
ok design-module.test.ts 1s
ok design-report.test.ts 1s
ok design-stylelint.test.ts 1s
```

A suíte lê a árvore de trabalho. Os commits seguintes só escolhem o que entra no índice, então a suíte não foi repetida dez vezes.

As duas falhas foram reproduzidas à parte e não vêm dos arquivos de design:

- `installation-readiness.test.ts`: o primeiro teste passa. O segundo espera stderr vazio do CLI `inspect` e recebe o aviso do Node de que `NO_COLOR` é ignorado porque `FORCE_COLOR` está definido.
- `workflow-runtime-bootstrap.test.ts`: `ENOENT` em `upstream/happier/node_modules/.agent-control-boundary.mjs`. O diretório `upstream/happier/node_modules` não existe.

`npm test` reescreveu `docs/validation/evidence/runtime-result.json` com outros ids sintéticos. O arquivo foi restaurado para o `HEAD` anterior e não entrou em nenhum commit.

Não rodei `npm run test:all`. Não construí a imagem Docker. O `npm ci` de `deploy/design-tools` instalou 371 pacotes no host para ter o Stylelint e o pa11y; `node_modules` continua ignorado pelo git. O postinstall do Puppeteer foi bloqueado; o Chrome foi `/usr/bin/google-chrome`.

## Painel

O detalhe está em `docs/validation/verificacao-design-painel.md`. Resumo medido:

- O build do Vite transformou 3175 módulos, emitiu o `dist` e falhou em 2,35 s: Rolldown não resolveu `@happier-dev/protocol` a partir de `upstream/happier/apps/cli/src/auth/terminalProvisioningResponse.ts`. O JS emitido (`assets/index-D5leAlf5.js`, 1 161 972 bytes) ainda tem um import nu desse pacote. O CSS tem 171 081 bytes. O `index.html` tem 6 339 bytes.
- Servidor estático em `http://127.0.0.1:4173`. `GET /` e `GET /tasks` responderam 200. O DOM headless tem `<div id="root"></div>` vazio. As capturas 375×812, 768×1024 e 1440×900 são a página preta, sem dado pessoal.
- Stylelint 18.0.0 em `src/styles/index.css`, regras `block-no-empty` e `color-no-invalid-hex`: `warnings` vazio, `parseErrors` vazio, `errored: false`.
- pa11y 10 com runner axe na URL servida: `[]`.
- `runDesignModule` com `designBenchWorker` (examinador `claude` / `bancada-especialista`, revisor `grok` / `bancada-revisor`, sem chamada paga) sobre 27 arquivos-fonte. Descobriu 49 rotas. Relatório `20261117-041000-design`, execução `df8f17c1-852b-4e2b-b73e-40fddacd8eb6`: 25 achados altos confirmados (20 `ESTADOS-VAZIO-AUSENTE`, 4 `WCAG-2-4-4-BOTAO-SEM-NOME`, 1 `TOKENS-CINZAS-DEMAIS`). O mapa do módulo ficou com 0 capturas porque essa chamada não recebeu driver de navegador. As três PNG foram feitas pelo Chrome headless, fora do módulo.

A bancada confirma regra plantada, WCAG ou `DESIGN-` e não descarta falso positivo. Os quatro botões incluem três com `aria-label={...}` em expressão JSX, que o heurístico não lê porque só aceita `aria-label` entre aspas. O estado vazio dispara em arquivo com `.map(` e sem `data-empty`, `Nenhum item` ou `empty-state`. O nono cinza é `rgba(27, 28, 29, 0.04)` de `--shadow-sm`, normalizado para `#1b1c1d`; os outros oito são tokens de tema, e o limiar é 8.

## O que ficou de fora

- A imagem `deploy/Dockerfile.design` não foi construída nem baixada. O disco estava em 92%, com 25 GB livres, e a base do Playwright é grande. O digest e o lockfile estão no repositório. O caminho do contêiner não foi executado.
- A interface do painel não pintou. Não houve exame visual de telas logadas, tema claro nem estados forçados na navegação.
- Não houve examinador multimodal pago. A confirmação desta prova é a bancada determinística.
- Os 81 testes de laboratório (Docker, SSH, Happier) não rodaram.
- `.grok-notas/` era rascunho de trabalho e foi apagada antes deste commit. Não entra no git.

## Riscos

- A nota de falha do painel mede a bancada, não a tela pintada. Heurísticos de estado vazio e de botão sem nome geram achado alto confirmado em código que já tem nome acessível ou que só usa `.map(`.
- Sem o `dist` de `@happier-dev/protocol`, o build do painel continua sem montar o React. Corrigir isso exigiria instalar o workspace Happier ou mudar o Vite, e isso não foi feito.
- O entrypoint, a rede internal e o usuário 65532 estão no Dockerfile e nos scripts, sem uma construção local que prove a imagem.
- Gravidade alta fora de regra plantada, WCAG ou id `DESIGN-` é rebaixada para informativa. Um achado novo que não siga esse prefixo não reprova sozinho.

## Rodada 2

Data: 2026-11-17. Sem push, sem merge e sem reescrita de histórico. O modo `locked` não mudou. Não há migração 101. A instalação viva, o gateway vivo, o banco `ac_ispagent`, o contêiner `ac-personal-pg` e o worktree do validador não foram alterados. Não houve compra de crédito. As chamadas de modelo usaram as assinaturas já copiadas para uma instalação descartável. `.grok-notas/` foi apagada antes deste commit e não entra no git.

`npm test` terminou com 189 arquivos ok e `failed` vazio. `npm run typecheck` também saiu 0. `workflow-runtime-bootstrap.test.ts` passou porque o boundary do Happier já estava neste worktree (`upstream/happier/node_modules/.agent-control-boundary.mjs`, arquivo local, 191108 bytes). Isso é do ambiente, não de um patch nesse teste. `installation-readiness.test.ts` deixa de herdar `NO_COLOR` quando `FORCE_COLOR` também está definido, para o stderr do `inspect` ficar vazio.

| Item | Commit | O que entrou |
|---|---|---|
| 1. Imagem | `d298d37f` | Entrypoint com cópia `0755` e `deploy/.dockerignore` |
| 2. Examinador | `78e2c168` | `npm run personal:design`, caminho nativo pessoal, capturas em arquivo |
| 3. Heurísticas | `4c034773` | Nome em expressão JSX, lista sem ramo de vazio, sombra translúcida fora do cinza |
| 4. Painel | `a348ab90` | Sete telas em 375, 768 e 1440, e o resultado do módulo |
| 5. Testes | `b0494585` | `installation-readiness.test.ts` |
| 6. Relatório | este commit | Esta seção |

### Imagem

A imagem que vale é `ac-design:ordem2`, id `sha256:4e529de6e86ee5b2f3ecdb94420ace0b764078d544b9b92f81220e96eb90732b`. Uma construção anterior, digest terminado em `0d18106e`, não conta e foi apagada para liberar disco. Não houve `docker system prune` nem apagamento de imagem ou volume de outro projeto.

Prova na rede internal `design-homologation`, usuário `65532:65532`, alvo `http://homologacao.local:8080`. Limites: memória e swap `2147483648`, `NanoCpus=2000000000`, pids 256, raiz só leitura, `cap-drop ALL`, `no-new-privileges`. `pa11y.status=0`, stdout `[]`, stderr sem `No usable sandbox`. URL externa continua `DESIGN_EXTERNAL_TARGET`. O Chrome da imagem recebe `--no-sandbox` porque o drop de capabilities impede o sandbox. O entrypoint copia a árvore em `0755` para o `find` conseguir atravessar.

### Examinador

O comando é `npm run personal:design -- <instalação.json> <projectId> --url <url> [--login-file <arquivo 0600>]`. Só ativação `personal`. A bancada `designBenchWorker` ficou para os testes.

O intento do exame entra como `accepted`, com o comando `plan.start` e o fluxo `design-readonly-v1`, sem outbox e sem plano congelado. A fila de capacidade ignora intento `done`, e a primeira tentativa real por isso voltou `CAPACITY_QUEUED`. Antes disso, a política de fábrica não tinha papel `specialist` e a reserva voltou `ROLE_NOT_CONFIGURED`. O núcleo de `capacity.reserve` não mudou. O supervisor nativo trata esse fluxo, em instalação pessoal e nos papéis `specialist` e `reviewer`, como exame somente leitura: não exige contrato de artefato, copia as capturas para o worker e aposenta o job sem evidência de estágio. O Happier pula o fluxo. O Cezar recusa com `DESIGN_INTENT_NOT_EXECUTION`. O CLI marca o intento `done` só quando o módulo volta.

As capturas vão para disco, modo `0600`, e o pedido manda o modelo abrir o PNG. Não vão em base64 no texto. O revisor é outro provedor (`DESIGN_PROVIDER_MUST_DIFFER`).

A execução que vale é `331663e8-79e1-4408-acee-ba9bf51eb9dc`, diretório `20261117-194844-design`, cerca de 48 minutos, contra o gateway descartável em `http://127.0.0.1:42539`. Examinador: Claude `claude-sonnet-5-5`, 20 chamadas (dez telas, com uma repetição quando a primeira resposta não era um único objeto JSON). Revisor: Codex `gpt-6.1-sol`, 91 chamadas. A cadeia de especialista existiu só na instalação descartável, revisão de política 2, regular Claude e emergência Grok. O combo de fábrica não publica `specialist` e não foi alterado. O JSON do modelo traz a lista como objeto, gravidade `low`/`high` e `cwe` vazio; o leitor normaliza isso antes do esquema da bancada.

Noventa e um achados. A nota de falha conta só confirmado ou reaberto: 2 altos, 17 médios, 13 baixos. Os dois altos confirmados são a captura de `/tasks/:id/*` que mostra só `{"error":"AUTH_REQUIRED"}` e códigos técnicos crus como mensagem de erro. Um alto ficou provável: `--soft-foreground` (`#a3a3a3`) sobre branco. O revisor descartou o inventário de oito cinzas quando não havia medida.

### Heurísticas

`aria-label`, `aria-labelledby` e `title` em expressão JSX contam como nome. "Estado vazio ausente" só sai para `ul`, `ol`, `data-list` ou `role=list` sem ramo de vazio no mesmo arquivo. `.map(` sozinho não gera o achado. Achado alto continua exigindo regra plantada, WCAG ou id `DESIGN-`. Alfa menor que 0,5 não entra como cinza. `tests/design-lab.test.ts` passou: os 8 defeitos plantados continuam reprovando e as telas boas continuam limpas.

### Painel

Build `VITE_AGENT_CONTROL_MANAGED=1 npm --prefix upstream/cezar run build:web`, Vite 8.1.4, 3739 módulos, 2,33 s. O Happier veio do checkout principal por link, e o boundary foi gerado neste worktree. Sete telas pintadas em 375, 768 e 1440 substituem as três páginas pretas. O combo na tela Equipe aparece como "nenhum". O detalhe está em `docs/validation/verificacao-design-painel.md`.

O módulo capturou oito rotas descobertas no fonte, não as rotas `/p/<projeto>/...` das capturas manuais. `/conversa`, `/novo-projeto` e `/new` pintaram a casca. `/tarefas` em 375 px mostrou o cabeçalho e a área principal vazia. `/equipe`, `/p/:projectId` e `/tasks/:id` responderam o documento `AUTH_REQUIRED` porque o parâmetro ficou literal. Ajustes foi pintado à mão e não entrou nas oito rotas. Não houve tema escuro nem estados forçados nessa corrida.

### O que ficou de fora

- O combo de fábrica ainda não tem cadeia `specialist`. Uma instalação nova precisa de uma revisão de política para o exame reservar o papel.
- A descoberta de rotas não substitui `:projectId`. Várias capturas do módulo não são a tela logada.
- A suíte `npm test` continua sem os testes de Docker, SSH e Happier. `workflow-runtime-bootstrap` depende do boundary já gerado.

## Rodada 3

Data: 2026-11-17. Ramo `task/modulo-design`. A base comum com o validador já estava no merge `2047b84c`; esta rodada não repetiu o merge e deixou o worktree do validador como estava. Sem push e sem reescrita de histórico. O modo `locked` não mudou. Não há migração 101. A instalação viva, o gateway vivo, o banco `ac_ispagent` e o contêiner `ac-personal-pg` ficaram como estavam. Não houve compra de crédito, exame ao vivo novo nem construção da imagem de design. `npm run test:all` não rodou.

| Item | Commit | O que entrou |
|---|---|---|
| A1. Isolamento | `ff69b979` | O exame `design-readonly-v1` (specialist e reviewer) usa o mesmo strip, mount `:ro`, login em tmpfs e wrapper do validador |
| M1. Capturas no job | `4d2b384f` | `stageDesignCapturesForJob` só no exame pessoal de design |
| M3. Rede do navegador | `21478cec` | `context.route('**/*')` bloqueia o que sai da origem declarada; a URL final entra na checagem depois do `goto` e do login |
| M4. Intento público | `a4d98066` | `ledger.accept` recusa `design-readonly-v1` com `DESIGN_INTENT_NOT_PUBLIC` (403) antes de gravar linha |
| B5. Prova medida | `d12a86fc` | O relatório registra usuário, limites e rede medidos em `designRunArguments` |
| B3. CLI | `5c7debec` | Código desconhecido imprime só `O exame de design falhou.` |
| B4. Leitura do repositório | `e5ea9515` | `readDesignRepository` pula `.claude/`, `.mcp.json`, `.codex` e `.grok` |
| M2. Capturas privadas | `c32a0316` | Diretório `<dataDirectory>/design-captures/<runId>`, modos 0700/0600, só o `runId` atual, limpeza de UUID órfão |
| A2. Alto com medida | `7dfd5be2` | `alta` exige medida estruturada; sem ela o achado fica `informativa` |
| B1. Nome acessível | `660fe073` | `alt` e `title` não casam `data-title` nem `aria-title`; spread não gera achado; `aria-label` vazio não é nome |
| M3. CLI | `15a5e7da` | `openDesignBrowser(parsed.url)` instala a guarda na origem declarada |
| A2. Régua | `df91fbd2` | A régua só confirma `alta` quando a medida existe |
| B2. Estado vazio | `e91e3065` | O marcador de vazio vale por componente, gravidade `media` |
| A3. Rotas | `4cf29842` | Rota com `:param`, `*` ou colchetes só abre com exemplo concreto; JSON não é tela |
| B5. Estado vazio e argv | `ca67b248` | Captura do vazio (`capturado`, `ausente`, `não capturado`) e a lista de argumentos, com a frase de que o relatório não executou o contêiner |
| A2. Inventário e teclado | `0aa910ee` | Inventário e teclado sem medida ficam `informativa` |
| A3. Documento JSON | `2da97b45` | Corpo de documento que não é HTML, inclusive JSON embrulhado pelo navegador, não vira captura |
| Tipos | `db6eabd8` | Os erros de tipo desta rodada |
| Suíte | `66e0e6d0` | O teste do relatório usa `DESIGN_RUNTIME_BIN` e permanece dentro de `npm test` |
| Relatório | este commit | Esta seção |

### Isolamento e intento

O exame de design pessoal, nos papéis specialist e reviewer, passa por `readonlyExamIsolation`: strip da cópia, `/account` somente leitura, login em tmpfs e o wrapper do exame. Programador, qa e judge não usam o atalho `personalReadonlyExam`. Um hook em `.claude/settings.json` que gravaria um marcador não grava, e a conta permanece intacta.

`design-readonly-v1` continua no esquema do comando, para um intento já gravado ainda parsear. A criação pública por `ledger.accept` recusa com `DESIGN_INTENT_NOT_PUBLIC` (403). Quem cria é o CLI do titular, por inserção direta. O modo `locked` continua exigindo política.

As capturas do job só são copiadas quando o job é exame pessoal de design. Fora do repositório elas ficam em `<dataDirectory>/design-captures/<runId>`. A cópia é do `runId` corrente. No início do exame seguinte, diretórios UUID deixados por um kill são removidos, sem seguir symlink e sem apagar nome que não seja UUID. `AC_DESIGN_CAPTURE_DIR` e `AC_DESIGN_CAPTURE_RUN` existem só em volta do exame. Sem elas, a busca em `.design-captures` do repositório permanece.

`readDesignRepository` ignora `.claude/`, `.mcp.json`, `.codex` e `.grok` em qualquer profundidade, com o nome exato e sem seguir symlink. `.cursor` e `.Claude` continuam na leitura.

### Achados

`alta` só permanece quando o achado traz medida estruturada: razão de contraste, px do alvo, px de transbordamento ou nome de arquivo PNG do estado vazio. Texto "WCAG" ou "DESIGN-" na referência não autoriza `alta`. Sem medida válida, o exame grava `informativa`. A régua não fabrica medida: contraste que já calculou a razão continua `alta`; botão sem nome, inventário, teclado, foco, cinzas, espaçamento, largura e texto cortado ficam `informativa` quando não há número.

Estado vazio ausente é `media` e só dentro do componente que tem a lista. Lista de itens literais, como navegação estática, não gera achado. Um marcador em outro componente não dispensa a lista. `data-title` e `aria-title` não contam como `title`. `{...props}` deixa o nome desconhecido e não gera achado. `aria-label=""` não conta como nome.

Rota com `:param`, `*`, `[id]`, `[...slug]` ou `[[...slug]]` não é aberta como texto. Um `example` concreto na mesma declaração é aberto; um exemplo que ainda é dinâmico é ignorado. Corpo JSON ou não-HTML, inclusive o documento que o navegador embrulha em HTML e cujo texto visível é só um objeto ou array JSON, é "não é tela" e não vira achado nem captura. `docs/validation/verificacao-design-painel.md` não trata mais o `AUTH_REQUIRED` de `/tasks/:id/*` como alto confirmado. A contagem da rodada 2 (91 achados, 2 altos) fica como histórico daquela corrida. Esta rodada não publicou outro total de exame ao vivo.

O relatório lista o estado vazio por rota (`capturado`, `ausente`, `não capturado`) ou registra que a captura não aconteceu. A prova da imagem traz o usuário `65532:65532`, os limites que `designRunArguments` aceita e a rede `design-homologation`. A seção de argumentos é a lista que a função usaria, com a frase de que o relatório não executou o contêiner. Código de CLI desconhecido imprime só `O exame de design falhou.`

### Números

`env -u NO_COLOR -u FORCE_COLOR npx tsc -p tsconfig.json --noEmit --pretty false`: código 0, depois do commit `66e0e6d0`. Sem aviso de `NO_COLOR`.

`umask 022 && env -u NO_COLOR -u FORCE_COLOR npm test`, com `AC_TEST_DATABASE_URL` no Postgres descartável `ac-design-r3-pg` (`127.0.0.1:54333`, banco `ac_implementation_test`): cerca de 720 s, código 0. Resumo: `{"passed":213,"failed":[],"excluded":84 arquivos}`. `design-report.test.ts`, `runtime.test.ts` e `workflow-runtime-bootstrap.test.ts` estão entre os 213. `notifications.test.ts` e `r3-secret-surfaces.test.ts` ficaram em `excluded` porque `upstream/happier/packages/cli-common/dist/providers/index.js` não existe neste worktree. O binário `hadolint` não está no PATH; o teste de `verify-dockerfile.test.ts` que depende dele foi pulado, e o arquivo em si passou.

`npm test` reescreveu `docs/validation/evidence/runtime-result.json` com outros ids sintéticos. O arquivo foi restaurado para o blob `3ae5a15c9eeba482ac89eb790809df1aee81edef` e não entra neste commit.

### O que ficou de fora

- A imagem `deploy/Dockerfile.design` não foi construída nesta rodada.
- Não houve exame ao vivo novo. O falso alto da rodada 2 sobre `/tasks/:id/*` saiu do texto do painel, sem um número substituto.
- `npm run test:all` não rodou. Os 84 arquivos de `excluded` (Docker, SSH, Happier, sudo e os dois que pedem o build do Happier) continuam fora.
- Não houve push.

