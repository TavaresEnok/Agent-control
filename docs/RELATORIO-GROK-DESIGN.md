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

## Reconstrução

Feita em 18/11/2026 no ramo `task/design-r3-image-proof`. A ordem pedia `task/modulo-design`, que está preso em outro worktree. O commit `3b3cd9d4` já estava reaplicado em `98f484fc` e não foi emendado. A imagem que rodou o laboratório é `localhost:5000/ac-design:reconstrucao@sha256:6cc1f850e13525a32fd7fb1e6518fc365bbbbeb3d35db1638ed4ee01ac119bcc` (id `sha256:52fcff805cd886a785bcb4c971eecb5a7218358c1f723661f7d2d65346f140da`).

### 1. Medição

`runDesignModule` executa a imagem como a CLI: rede `design-homologation`, usuário 65532, raiz só de leitura, sem capability, e o plano em `/output/pedido.json`. Dentro da imagem, `run-exam.mjs` usa o Playwright do contêiner e grava `achados-brutos.json`. Uma corrida anterior nesta mesma imagem viu 2 rotas, porque `design.config.json` não entra na lista de código. A corrida que vale é a de 18/11/2026, 456 s, código 0, com o config lido da raiz do fixture.

| Ferramenta | Versão | Executado | Achados | Falha |
|---|---|---|---|---|
| axe-core | 4.14.1 | 3 rotas × 3 viewports × 2 temas | 1027 | nenhuma |
| pa11y | 10.0.0 | 6 urls × runners axe+htmlcs | 24 | nenhuma |
| lighthouse | 13.6.0 | 6 corridas mobile+desktop | 6 | nenhuma |
| stylelint | 18.0.0 | 1 arquivos css | 2 | nenhuma |
| css-analyzer | 9.9.9 | 43 folhas | 43 | nenhuma |

O lock de `deploy/design-tools` passou a listar `lighthouse`, `pixelmatch`, `playwright` e `pngjs` como dependências diretas, nas versões exatas, depois desta imagem. A imagem não foi reconstruída de novo. As versões da tabela são as que o exame leu em `/opt/design-tools/node_modules`.

### 2. Tokens

Os estilos computados viram `tokens.json` DTCG. No laboratório a escala mais próxima foi Apple Human Interface Guidelines, distância 0,061. O relatório lista 15 tamanhos (os 14 plantados e o 13,33 do navegador), 1305 pares de cinza com ΔE2000 abaixo de 3, e contraste 1,41 com APCA Lc 7,2. O alvo de 30 px está em `bruto/achados-brutos.json` como `DESIGN-ALVO-REFERENCIA`, medida `target` 30, contra o mínimo de 44 px da Apple. Esse achado não entrou na lista confirmada pelo examinador de bancada.

### 3. Crítica visual

Nove eixos, texto original do módulo. No laboratório a tela genérica (gradiente `#6d28d9`/`#7c3aed` e cartões iguais) gerou `DESIGN-VISUAL-HIERARQUIA`, `DESIGN-VISUAL-COMPONENTES` e `DESIGN-VISUAL-MARCA`, confirmados. A marca ficou em julgamento incerto: examinador 3, revisor 6.

### 4. Referências do titular

`--referencia` existe no exame e em `criar`, até 10 PNG ou JPG, copiados para o diretório privado do run em 0600. O teste de unidade cobre a cópia fora do repositório. O laboratório da imagem não recebeu arquivo de referência.

### 5. Regressão visual

Com limiar 0,1 e sem baseline aprovada, o relatório diz "Sem baseline aprovada. Nada foi comparado." A promoção da baseline é `--aprovar-baseline` e não relê o exame. Esse comando não foi exercido num relatório real desta rodada. Captura vazia nesse caminho recusa com `DESIGN_IMAGE_FAILED`.

### 6. Estados

O módulo lê `design.config.json` só na raiz, com `O_NOFOLLOW`, e não segue symlink. JSON inválido recusa com `DESIGN_CONFIG_INVALID`. No laboratório, `/` capturou vazio, carregando, erro e logado; `/item/:id` abriu `/item/42`; `/painel` e `/item/42` ficaram com a nota de estados não capturados, porque a declaração deles é uma lista vazia.

### 7. Modo criar

O comando rodou na instalação de teste `324be55d-b879-4314-a387-578fb299a7b4`:

`npm run personal:design -- criar /home/app/srv_projetos/workspace/ac-smoke-data/installation.json 324be55d-b879-4314-a387-578fb299a7b4 --briefing /tmp/design-create-briefing.md --telas 2 --rodadas 1`

A CLI imprimiu "O exame de design falhou." e saiu com código 1. A reserva do assento recusou com `CAPACITY_POLICY_REQUIRED`: o contexto mais antigo do projeto tem `capacity_policy_revision` nulo. O catálogo `ac_model_catalog` dessa instalação tem `claude-sonnet-5-5` (low, medium, high) e não tem `claude-opus-5-5`. O par forçado, se a reserva tivesse passado, cairia em `DESIGN_CREATE_MODEL_UNAVAILABLE`. Nenhuma tela foi desenhada nem gravada. O laço de rodadas com examinador de bancada está coberto por teste: duas rodadas, diretório fora do repositório, vitrine com aprovadas e rejeitadas.

### 8. Prova do fixture

`tests/fixtures/design-lab-v2`, teste `tests/design-lab-image.test.ts` com `AC_DESIGN_LAB=1`. Defeitos que chegaram ao relatório:

- contraste `#b0b0b0` sobre `#d0d0d0`, razão 1,41, axe `WCAG-1-4-3-CONTRASTE`, alta confirmada
- imagem sem alt, axe `WCAG-image-alt` e pa11y `H37`
- Lighthouse `LH-LCP` 5289 ms, `LH-CLS` 0,557 e desempenho 0,35, no bruto; no achado confirmado o Stylelint `declaration-no-important` e `block-no-empty` ficaram `media` `provavel`
- 14 tamanhos plantados dentro dos 15 medidos, e os 9 cinzas plantados dentro dos pares ΔE2000
- alvo 30 px no bruto
- tema escuro com texto `#1c1c1c` sobre fundo `#111111` entra no contraste do axe
- crítica da tela genérica, como no item 3

Nenhum campo da tabela de cobertura ficou vazio. Ferramenta quebrada, sem JSON, continua coberta pelo teste que marca as cinco linhas com `DESIGN_IMAGE_FAILED`.

`npx tsc --noEmit`: código 0. Os testes de design focados, sem o laboratório de Docker: 51 passaram. `tests/design-image-run.test.ts` compara o binário com `DESIGN_RUNTIME_BIN`, para a suíte oficial não classificá-lo como teste de Docker.

`umask 022 && env -u NO_COLOR -u FORCE_COLOR npm test`, com `AC_TEST_DATABASE_URL` no Postgres descartável `ac-design-r3-pg` (`127.0.0.1:54333`, banco `ac_implementation_test`): cerca de 662 s, código 0. Resumo: `{"passed":223,"failed":[],"excluded":84}`. `design-image-run.test.ts`, `design-reconstruction.test.ts` e `design-lab-image.test.ts` (pulado sem `AC_DESIGN_LAB`) estão entre os 223. O laboratório com `AC_DESIGN_LAB=1` é a corrida de 456 s acima, fora dessa suíte. `npm test` reescreveu `docs/validation/evidence/runtime-result.json`. O arquivo foi restaurado para o blob `3ae5a15c9eeba482ac89eb790809df1aee81edef` e não entra nos commits.

### Commits

| Item | Commit | O que entra |
|---|---|---|
| 1. Medição | `16815014` | imagem, `run-exam.mjs`, digest e leitura do JSON |
| 2. Tokens | `bfd697c6` | DTCG, cor e as referências numéricas |
| 3. Crítica visual | `11ddd4ce` | nove eixos e o julgamento incerto |
| 4. Referências | `08fabdbb` | cópia privada dos PNG e JPG |
| 5. Regressão | `16840af5` | pixelmatch depois da baseline aprovada |
| 6. Estados | `e85c4f43` | `design.config.json` na raiz, sem seguir symlink |
| 7. Modo criar | `e7c763b4` | Opus 5.5 medium forçado e a recusa do catálogo |
| 8. Encaixe | `0e2ba503` | `runDesignModule`, CLI, fixture, suíte e este texto |

O arquivo `upstream/happier/apps/server/generated` continua fora do git.

### O que não ficou pronto

- A criação real de 2 telas e 1 rodada não produziu HTML. O bloqueio é a política de capacidade do contexto e a ausência de `claude-opus-5-5` no catálogo.
- Nenhuma referência PNG/JPG entrou no laboratório da imagem.
- `--aprovar-baseline` não foi usado num relatório real com capturas.
- A imagem não foi reconstruída depois da atualização do lock. O digest acima é o da imagem que executou a prova.
- `DESIGN-ALVO-REFERENCIA`, os achados de token e os de Lighthouse estão no bruto e, no caso dos tokens, na seção Tokens. Não estão entre os achados confirmados da bancada.
- Não houve push. O contêiner `ac-personal-pg` não foi reiniciado, removido nem migrado.


## Reconstrução, rodada 2

Feita em 18/11/2026 no ramo `task/design-r3-image-proof`, em cima de `1dbaca5a`. A imagem que rodou o laboratório e o `--servir` é `localhost:5000/ac-design:reconstrucao@sha256:70c5a72286bf518369b7a2683cff9ae7acaed0aa75bdde7bd31d14d0cc687502` (id local `sha256:9d58ee70d5c3c4ae83a6fa6975b9dc084318da7b44339d6b7a69e0021ae29dbd`). O digest está em `deploy/design-image-digest.txt`.

### 1. Project Wallace

`interpretDesignImageDocument` conserva `reports.cssAnalyzer`. `wallaceFindings` converte o relatório em achados com medida: cores, tamanhos de fonte, famílias, `!important`, especificidade máxima e média, seletores por regra, declarações duplicadas, z-index distintos e unidades misturadas. Os limites estão no código (mais de 8 tamanhos, especificidade estritamente acima de 0,3,0, e os demais cortes ao lado). A imagem grava 0 na coluna Achados; o host reconta os achados da ferramenta `css-analyzer`.

No laboratório: 37 folhas executadas, 49 achados, falha nenhuma. Entraram, entre outros, `DESIGN-WALLACE-FONTES`, `DESIGN-WALLACE-ESPECIFICIDADE`, `DESIGN-WALLACE-UNIDADES` e `DESIGN-WALLACE-IMPORTANT`, confirmados pela medida.

### 2. Contraste com transparência

`parseCssColor` lê alfa em `rgb()`, `rgba()`, `#rgba`, `#rrggbbaa`, `transparent` e `rgb(0 0 0 / 0.5)`. O fundo efetivo é a composição dos ancestrais até um fundo opaco. Imagem ou gradiente no caminho vira "contraste não medido". O teste de unidade cobre texto escuro num elemento transparente dentro de fundo branco.

No laboratório o parágrafo "Texto escuro sobre fundo herdado" (`#1c1c1c`, fundo transparente, seção `#ffffff`) aparece só como achado de região do axe. O contraste de token é o par plantado `#b0b0b0` sobre `#d0d0d0`, razão 1,41, APCA 14,5, confirmado sem revisor. A seção Tokens registra 54 contrastes não medidos, o gradiente do corpo.

### 3. Referências do titular como imagem

PNG e JPG do `--referencia` seguem o caminho da captura: cópia 0600, nome em minúsculas, até 10 arquivos, até 8 MB, mágica PNG ou JPG. Nome que só difere na caixa recusa com `DESIGN_REFERENCE_INVALID`. O pedido do worker lista o arquivo, o sha256 e `contêiner=/planning/capturas/<sha>.png`. O examinador recebe a distância por eixo (0–10). O relatório tem a seção Referências.

O laboratório mandou um PNG de 1×1. A seção diz "Referências visuais (1): referencia.png" e o teste do pedido viu a linha com sha256 e o caminho no contêiner.

### 4. APCA

`apcaLc` subtrai 0,027 (`loBoWoffset` / `loWoBoffset`). O `loClip` 0,1 continua só como teto do grampo. Medido no teste: preto sobre branco 106,04067321268862; branco sobre preto −107,88473318309848; cinza 128 sobre branco 63,72448153616479.

### 5. Estados de verdade

O `?estado=` inventado saiu. Um estado entra na captura quando `design.config.json` traz `url` (caminho relativo, mesmo host) ou `acoes` (`clicar`, `preencher`, `esperar`). Os dois juntos recusam com `DESIGN_CONFIG_INVALID`. Logado usa `--login-file`: o host grava o `storageState` em 0600, monta só leitura em `/login/state.json` e apaga no fim. A senha não entra no contêiner, no `pedido.json`, no ambiente nem no relatório. Sem declaração, a linha é "não capturado".

O laboratório devolve texto diferente em `/estado/vazio`, `/estado/carregando` e `/estado/erro`. As capturas saíram com esses nomes, nos dois temas. Não houve print de logado: o fixture não entregou arquivo de login, e o relatório diz "estado logado não capturado". O login no Chrome do host está no código e não foi exercido com senha nesta rodada.

### 6. Status HTTP

Status ≥ 400 ou erro de navegação não é examinado. A cobertura ganha "rota indisponível (status)" e o achado `DESIGN-ROTA-INDISPONIVEL` (ferramenta `navegacao`), confirmado pela medida. No laboratório, `/ausente` respondeu 404 e virou o achado ACH-105, sem revisor. Axe não rodou nessa célula.

### 7. Executado é o que terminou

A célula Executado conta células concluídas. Falha lista até 8 itens e o total ("e mais N"). pa11y corre por rota × viewport: saída 0 (limpo) e saída 2 (achados, JSON em lista) contam como feito; outro status, status ausente ou JSON ilegível é falha e a célula não entra na conta. Lighthouse corre mobile e desktop separados, com o fator de forma no relatório. JSON ilegível com saída 0 é falha. Contêiner com saída diferente de 0 conserva o JSON, marca `ok` para o exame seguir e grava o código `DESIGN_IMAGE_FAILED`. Um teste quebra axe, pa11y e Lighthouse um de cada vez e só aquela linha fica em falha.

No laboratório a linha do pa11y é "nenhuma", com 84 achados: os defeitos plantados saem com status 2.

### 8. Medido e julgado

Achado com `DesignMeasure` entra confirmado pela medida, com verificador nulo e fonte `medida`: Lighthouse LCP, CLS e TBT, tokens, alvo menor que 24 px ou 44 px, contraste medido e Wallace. Se várias ferramentas nomeiam o mesmo achado, a medida guardada segue a ordem axe, pa11y, lighthouse, tokens, css-analyzer, régua. O modelo continua confirmando o que é subjetivo ou não tem medida. O relatório marca "confirmado (medido)" quando o verificador é nulo e as fontes incluem `medida`.

No laboratório, contraste, tokens, Wallace, LH-LCP, LH-CLS, `DESIGN-ALVO-REFERENCIA` e `DESIGN-ROTA-INDISPONIVEL` ficaram sem revisor. A crítica visual foi confirmada pelo examinador Claude. Stylelint `block-no-empty` e `declaration-no-important` ficaram `provavel`.

### 9. Referências de design system

`spacePx`, `typePx`, `radiusPx` e `elevation` foram preenchidos onde a fonte publica o valor. Material 3 usa o espaçamento de 4 em 4. A paleta usa `colorSteps` do Radix. A distância é a média dos campos que os dois lados têm; elevação fica guardada e fora da conta; referência com menos de dois campos fica fora da disputa. Carbon entra com tipo e espaço, Polaris com tipo, espaço e raio, GOV.UK com tipo e espaço, Material com tipo, espaço e raio. Apple HIG publica só tipo e fica fora da disputa.

No laboratório a escala mais próxima foi Material Design 3, distância 0,161. Quinze tamanhos contra 11 dessa escala, e 7 espaçamentos fora dela. A paleta mediu 0 passos por matiz, rampa não, 12 passos na referência. A distância 0,061 da Apple, da rodada 1, não se aplica a esta conta.

### 10. HTML gerado

`stripGeneratedHtml` por regex saiu. O sanitizador é parse5 7.3.0, versão exata. Saem `script`, `on*`, `iframe`, `object`, `embed`, meta refresh, `<base>` e `javascript:`. URL externa em `src`, `href`, `srcset`, `@import`, `url()` e `//` também sai. A exceção é `fonts.googleapis.com` e `fonts.gstatic.com` em `<link>`. Os vetores têm teste.

### 11. Retrabalho por tela

A aprovação é por tela: só a reprovada volta. O pedido leva o HTML anterior, cortado em 8000 caracteres, os achados com medida e as notas visuais. `</head>` ausente é inserido na árvore. A vitrine lista as rodadas e a evolução das notas. O retorno combinado do exame é `{screens: {name, rejected, findings, visualNotes}[]; notes}`. A CLI marca `rejected` quando a nota visual é baixa ou há achado alto da tela, e `visualNotes` fica vazio ou "nota visual abaixo de 8".

### 12. Servidor do modo criar

O criar deixou o `serve-lab.mjs` (os atrasos de `/` e `/hero.jpg` continuam só no laboratório). `serve-static.mjs` não atrasa, serve arquivos da pasta, não lista diretório, bloqueia `..` e symlink que escapa (realpath), manda MIME e `cache-control: no-store`. Responde GET e HEAD; o resto volta 405. A ordem pedia só GET; HEAD ficou porque é a mesma leitura, sem corpo, e o teste de ponta a ponta confere os dois. `createStaticServer(root)` só escuta quando o arquivo é o ponto de entrada. Raiz `DESIGN_STATIC_ROOT` ou `/srv`, porta `DESIGN_STATIC_PORT` ou 8080. O criar monta `pub` em `/srv` e usa o alias `design-create.local`.

### 13. Supervisor

`model` e `effort` forçados valem só para o papel de criar design numa instalação pessoal (`specialist`, fluxo `design-readonly-v1`, tarefa que começa com "Pedido de criação."). Qualquer outro pedido com esses campos recusa `DESIGN_CREATE_MODEL_UNAVAILABLE`. O par tem de ser `claude-opus-5-5` e `medium`. A conta reservada precisa oferecer esse par no catálogo e já no perfil do grant ou numa linha de `ac_profiles` dessa conta. O grant grava `effectiveModel` e `effectiveEffort` no `selection`, em merge, dentro da transação que o marca `running`. O criar segue por `acceptClaudeExamSeat`; provedor que não é `claude` recusa `EXAM_PROVIDER_UNSUPPORTED`.

### 14. Diretório temporário

Opção 3. O diretório de saída, e o de capturas, fica `01777` com sticky só enquanto o uid 65532 escreve. O host não é esse uid, e `DESIGN_USER` continua `65532:65532`. Antes de ler, `lstat`: arquivo regular, não symlink, uid 65532, `(mode & 022) === 0`, aberto com `O_NOFOLLOW`. 0644 passa. 0666 recusa e o exame fica `DESIGN_IMAGE_FAILED`. O `finally` apaga o diretório.

### 15. `--servir`

O exame sobe a pasta com `serve-static.mjs` na rede `design-homologation`, contêiner `ac-design-servir-` mais 8 hex, usuário 65532, raiz só leitura, cap-drop ALL, `pull` never, pasta em `/srv`, alias `design-servir.local:8080`. As rotas são os `.html` da pasta: `index.html` vira `/`, o resto o caminho, sem `node_modules`, profundidade até 4, no máximo 40. Alvo `localhost` ou `127.0.0.1` sem `--servir` recusa `DESIGN_TARGET_UNREACHABLE` (400) e a mensagem diz para usar `--servir`.

Prova de ponta a ponta, `AC_DESIGN_LAB=1`, três HTML, 136,83 s, código 0. Rotas `/`, `/painel.html` e `/item/detalhe.html`. `node_modules/skip.html` não entrou. POST devolveu 405, HEAD 200, `/%2e%2e/secret` 404.

| Ferramenta | Versão | Executado | Achados | Falha |
|---|---|---|---|---|
| axe-core | 4.14.1 | 9 células | 18 | nenhuma |
| pa11y | 10.0.0 | 9 células rota×viewport | 0 | nenhuma |
| lighthouse | 13.6.0 | 3 mobile, 3 desktop | 0 | nenhuma |
| stylelint | 18.0.0 | 0 arquivos do repositório, 1 blocos de página | 0 | nenhuma |
| css-analyzer | 9.9.9 | 9 folhas | 9 | nenhuma |

O bloco de página é um porque as três páginas repetem o mesmo `body{margin:0}` e o exame deduplica o texto. As 9 folhas são o CSS computado das três rotas nos três viewports.

### Baixos

O nome da baseline leva 8 hex de sha256 da rota, então `/a-b` e `/a/b` não colidem. `baselineBuffer` também valida `projectId` e o nome do PNG; o resto recusa `DESIGN_PATH_FORBIDDEN`. Arquivos já aprovados não foram renomeados. Células das duas tabelas de cobertura escapam `|` e quebra de linha. `assertPasswordAbsent` serializa o relatório, seções, arquivos extras e cobertura. O laboratório escreve o JSON em `join(data, 'lab-summary.json')`, imprime no stdout e o `finally` apaga o diretório. Stylelint também corre nos `<style>` da página; sem CSS no repositório a linha é "0 arquivos do repositório, N blocos de página". O relatório mostra a nota do revisor ao lado da do examinador, e a distância da referência.

### Laboratório da imagem

`tests/design-lab-image.test.ts` com `AC_DESIGN_LAB=1`, 302,51 s, código 0, `fail 0`. A suíte oficial inclui esse arquivo e pula sem a variável (cerca de 1–2 s).

| Ferramenta | Versão | Executado | Achados | Falha |
|---|---|---|---|---|
| axe-core | 4.14.1 | 36 células | 229 | nenhuma |
| pa11y | 10.0.0 | 12 células rota×viewport | 84 | nenhuma |
| lighthouse | 13.6.0 | 4 mobile, 4 desktop | 6 | nenhuma |
| stylelint | 18.0.0 | 1 arquivos do repositório, 0 blocos de página | 2 | nenhuma |
| css-analyzer | 9.9.9 | 37 folhas | 49 | nenhuma |

A rota `/item/:id` abriu `/item/42`. O tema escuro aparece nas capturas porque o CSS do fixture tem `prefers-color-scheme`, e `planDesignRoutes` liga o tema quando a fonte ou o config pede. `dark: false` no config não desliga uma media query da fonte.

### Suíte e tipos

`npx tsc --noEmit`: código 0, depois da separação do teste que grava JSON como uid 65532.

`umask 022 && env -u NO_COLOR -u FORCE_COLOR npm test`, com `AC_TEST_DATABASE_URL` no Postgres descartável `ac-design-r3-pg` (`127.0.0.1:54333`, banco `ac_implementation_test`).

Durou 666 s, código 0. Resumo: `{"passed":231,"failed":[],"excluded":87}`. `design-measure-source.test.ts`, `design-image-run.test.ts` e `workflow-runtime-bootstrap.test.ts` (17 s) estão entre os 231. `design-lab-image.test.ts` entrou e foi pulado sem `AC_DESIGN_LAB` (1 s).

Uma corrida anterior desta mesma árvore, antes do desempate da medida, falhou `design-measure-source.test.ts`: a primeira medida crua (stylelint, razão 9,9) ganhava da do axe (2,1). A ordem das ferramentas ficou axe, pa11y, lighthouse, tokens, css-analyzer, régua. A mesma corrida falhou `workflow-runtime-bootstrap.test.ts` em 6 s. Isolado, com o mesmo banco, esse arquivo passou em 18 s. O arquivo não foi alterado nesta rodada.

Fora da suíte oficial, porque o fonte cita Docker: `design-image-owner.test.ts` (1 passou), `design-round2-guards.test.ts` (6 passaram), `design-servir-e2e.test.ts` (1 passou, a prova acima) e `native-execution-supervisor.test.ts` (4 passaram, com o banco descartável). `npm test` reescreve `docs/validation/evidence/runtime-result.json`. O arquivo foi restaurado para o blob `3ae5a15c9eeba482ac89eb790809df1aee81edef` e não entra no commit.

### Commits

| Item | Commit | O que entra |
|---|---|---|
| 1. Wallace | `d212f69f` | achados medidos; a coluna Achados é recontada no módulo `b02c9072`; a célula da imagem fica 0 em `7b82f352` e o host substitui pelo número de achados |
| 2. Contraste | `18321af5`, `589960d6` | alfa e o achado; o fundo efetivo está em `7b82f352` |
| 3. Referências como imagem | `f2028c1a` | cópia, distância e a seção; o examinador também em `f10039c3` |
| 4. APCA | `18321af5` | deslocamento 0,027 |
| 5. Estados | `c625f694` | declaração, login do host e o servidor do laboratório |
| 6. Status HTTP | `7b82f352` | rota indisponível |
| 7. Executado | `7b82f352`, `a3d41e62` | células concluídas e a saída do contêiner |
| 8. Medido e julgado | `f10039c3` | confirmação pela medida e o rótulo do relatório |
| 9. Escalas | `589960d6` | campos publicados e a disputa |
| 10. HTML | `012ea4ac` | parse5 7.3.0 |
| 11. Retrabalho | `012ea4ac` | uma tela por vez e a vitrine |
| 12. Servidor estático | `8b3bd679` | `serve-static.mjs` no criar |
| 13. Supervisor | `1251b298` | Opus 5.5 medium só no criar pessoal |
| 14. Diretório temporário | `a3d41e62` | 01777 só durante a escrita, depois dono e modo |
| 15. `--servir` | `8b3bd679` | pasta estática na rede de homologação |
| Baixos e encaixe | `b02c9072`, `67940743` | módulo, baseline, fixture, digest; o teste sem Docker volta para a suíte |

O arquivo `upstream/happier/apps/server/generated` continua fora do git.

### O que não ficou pronto

A criação real de 2 telas e 1 rodada não produziu HTML. O comando foi:

`npm run personal:design -- criar /home/app/srv_projetos/workspace/ac-smoke-data/installation.json 324be55d-b879-4314-a387-578fb299a7b4 --briefing /tmp/design-create-briefing.md --telas 2 --rodadas 1`

A CLI imprimiu "O exame de design falhou." e saiu com código 1. O mapa de mensagens da CLI não tem `CAPACITY_POLICY_REQUIRED`. Uma chamada seguinte pelas mesmas funções do produto (`resolvePersonalDesign` e `runDesignCreate`, com o worker recusando antes de desenhar) resolveu a intenção `f29ceae5-ca8c-4d7d-bc33-af89828018a4` e falhou com `CAPACITY_POLICY_REQUIRED`. `resolvePersonalDesign` escolhe `ORDER BY created_at LIMIT 1`. Esse contexto é `c35e02b4-d427-4198-80c6-2d6132990f9e`, criado em 2026-11-10, com `capacity_policy_revision` nulo. A revisão 1 da política não tem cadeia de especialista. Os perfis do projeto são Claude Sonnet medium (manager, qa, reviewer) e Grok programmer. O catálogo não tem `claude-opus-5-5`.

Não há comando `npm run personal:*` que acrescente um perfil especialista `claude-opus-5-5` em esforço medium na conta Claude reservada e coloque esse perfil na cadeia de capacidade do projeto. `personal:combo apply complexo` publicaria uma política, registraria o Opus e trocaria o time atual por manager e revisor em esforço alto, sem papel especialista em medium. Não foi aplicado. Não houve SQL, nem `docker exec` no `ac-personal-pg`. A intenção aceita ficou na instalação de teste; o lease de manager da CLI expirou. O gateway em `127.0.0.1:18421` estava fora e não foi a causa: o criar monta o supervisor no processo.

O login do host com arquivo de senha não rodou no Chrome. O laboratório prova o caminho "não capturado".

Não houve push. O contêiner `ac-personal-pg`, o banco `ac_ispagent`, a instalação viva e o gateway vivo não foram alterados.

## Reconstrução, rodada 3

Feita em 18/11/2026 no ramo `task/design-r3-image-proof`. A ordem partiu do commit `3c5d24be`. O fechamento desta seção está em cima de `b7e2423c`.

### 1. `personal:design preparar`

Comandos, na instalação de teste, projeto `324be55d-b879-4314-a387-578fb299a7b4`:

```
npm run personal:design -- preparar /home/app/srv_projetos/workspace/ac-smoke-data/installation.json 324be55d-b879-4314-a387-578fb299a7b4
```

Saída, código 0:

```
Preparação, sem gravar.
Catálogo: claude-opus-5-5 entraria por personal://account-add.
Perfis specialist:
- criar: claude-opus-5-5 medium conta 620428b1-5d25-4c31-bd3d-fa04a8c9827d perfil novo (criar, conta)
- examinador: claude-sonnet-5-5 medium conta 620428b1-5d25-4c31-bd3d-fa04a8c9827d perfil novo (criar, conta)
- revisor: claude-sonnet-5-5 medium conta 620428b1-5d25-4c31-bd3d-fa04a8c9827d perfil novo (criar, outra sessão)
Cadeia specialist:
- regular: novo:criar, novo:examinador
- emergência: novo:revisor
Contextos sem política: c35e02b4-d427-4198-80c6-2d6132990f9e
Revisão atual: 1
```

O mesmo comando com `--aplicar`, código 0:

```
Preparação aplicada.
Catálogo: claude-opus-5-5 entraria por personal://account-add.
Perfis specialist:
- criar: claude-opus-5-5 medium conta 620428b1-5d25-4c31-bd3d-fa04a8c9827d perfil 064dafd0-32a3-4216-9a07-8575d7dd8ad7 (criar, conta)
- examinador: claude-sonnet-5-5 medium conta 620428b1-5d25-4c31-bd3d-fa04a8c9827d perfil d7406c15-34cb-4a7d-92c3-674a413ea63d (criar, conta)
- revisor: claude-sonnet-5-5 medium conta 620428b1-5d25-4c31-bd3d-fa04a8c9827d perfil b6c06928-875b-4403-93e1-2e6700ea8e4c (criar, outra sessão)
Cadeia specialist:
- regular: 064dafd0-32a3-4216-9a07-8575d7dd8ad7, d7406c15-34cb-4a7d-92c3-674a413ea63d
- emergência: b6c06928-875b-4403-93e1-2e6700ea8e4c
Contextos sem política: c35e02b4-d427-4198-80c6-2d6132990f9e
Revisão: 1 -> 2
```

A linha do catálogo dessa aplicação diz "entraria" porque o texto foi calculado antes da gravação. O commit `6e8fccef` faz a aplicação dizer "entrou por personal://account-add". A segunda execução com `--aplicar` imprimiu só `Nada a mudar.` e saiu com código 0.

Há uma conta Claude no projeto, `620428b1-5d25-4c31-bd3d-fa04a8c9827d`, então o revisor ficou em outra sessão dessa conta. A revisão passou de 1 para 2 e só acrescenta `roles.specialist`. O contexto que estava sem política, `c35e02b4-d427-4198-80c6-2d6132990f9e`, passou a usar a revisão 2.

Commits: `64ff4ea7` (comando, testes e a CLI) e `6e8fccef` (o texto do catálogo depois da gravação).

### 2. Exame real com `--servir`

A pasta servida foi `/tmp/design-r3-servir`, com `index.html`, `painel.html`, `item.html`, `css/site.css` e `foto.png`. O CSS não entra como tela.

```
npm run personal:design -- /home/app/srv_projetos/workspace/ac-smoke-data/installation.json 324be55d-b879-4314-a387-578fb299a7b4 --servir /tmp/design-r3-servir --url http://127.0.0.1:8080
```

A primeira corrida, `73f6d6c8-5f3d-43e7-bb88-52df6ffd9850`, diretório `20261118-074902-design`, saiu com código 0. A nota geral diz que nenhuma tela de código entrou no exame. O commit `8c7d2f53` manda os HTML servidos para o exame.

As corridas seguintes recusaram `NATIVE_IMAGE_MISSING`. A CLI imprime "O exame de design falhou." O bootstrap da instalação de teste apontava imagens que o daemon não tinha. O acerto foi `native-setup` do produto, com as três imagens já no daemon, sem `personal:images` e sem `personal:setup`. O worker novo é `sha256:48270d13109118edc9a6679646e7344ff8f29bfa9676c1d65889c2a95e93057a`. O planning continua `sha256:8c9b7d04e9fffc0f495fadb4f616ee8d158075af7ffb6428377fa205fcb95c64`. As tools continuam `sha256:9a1fa0650e34b7e5421411264be3b1490b3ee9676ff982e89148f888ab31142b`. O resultado foi `{"state":"active","accounts":3}`. A imagem do worker foi reconstruída a partir do fonte atual para copiar o login do exame para um diretório gravável quando `AC_VERIFY_EXAM=1`. A imagem antiga do worker, `sha256:167ab26fc5fd519f05314749838640432dd44fdb0fc6fdf0f882dd990e35aed1`, continua no disco.

A corrida `63e596a5-5905-48a3-bb39-61f9baa48db9`, diretório `20261118-081208-design`, saiu com código 0. As três telas entraram. A nota geral diz que o exame de `index.html`, `item.html` e `painel.html` não veio em JSON válido. Não há seção Crítica visual. Os jobs `06155339-b319-491d-b915-2669b169bfea`, `6dbb69be-7a0a-4a5a-a229-d022238f4b00` e `6fc7f75b-3ff8-4b5f-8069-22b56cf894dc` saíram com `EXECUTION_NATIVE_FAILED`, saída vazia e tokens nulos. Essa corrida ainda usava o worker antigo.

O registro medido desta rodada é a execução `e13b3e7f-e5d0-44db-bdde-e0624f1efa58`, diretório `/home/app/srv_projetos/workspace/ac-smoke-data/verificacoes/324be55d-b879-4314-a387-578fb299a7b4/20261118-083422-design`, código 0, gerada em 2026-11-18T08:34:22.874Z. O commit do repositório smoke é `7e7c68dad3ee61468f1ac35d787241625a3074b8`. A imagem de design foi `localhost:5000/ac-design:reconstrucao@sha256:7320bb1b49eda069fb66da92455769abb2cbf5716adefcbb655ea332523cd3b0`. Os jobs `53ac94c7-0a3d-44c7-9a1e-9f36a9794bd1`, `3cab398d-bbc0-4f3a-91e3-5613cea6b8f5` e `989cab82-e9dc-43b5-bf4e-0358b799eb7f` saíram com `EXECUTION_NATIVE_FAILED`, saída de tamanho 0 e tokens nulos, já no worker novo.

Cobertura das ferramentas:

| Ferramenta | Versão | Executado | Achados | Falha |
|---|---|---|---|---|
| axe-core | 4.14.1 | 9 células | 88 | nenhuma |
| pa11y | 10.0.0 | 9 células rota×viewport | 72 | nenhuma |
| lighthouse | 13.6.0 | 3 mobile, 3 desktop | 2 | nenhuma |
| stylelint | 18.0.0 | 0 arquivos do repositório, 0 blocos de página | 0 | nenhuma |
| css-analyzer | 9.9.9 | 9 folhas | 12 | nenhuma |

A tabela de itens por tela nomeia o examinador planejado `claude/claude-opus-5-5` em `index.html`, `item.html` e `painel.html`.

Tokens: tamanhos 10, 11, 12, 13, 13.33, 15, 16, 18, 20, 22, 24, 28, 32, 40 e 48. Famílias Times New Roman e Arial. Espaçamentos fora da grade de 4 px: 10, 11, 13, 15, 18, 21.44 e 22. Há 72 pares de cinza com ΔE2000 menor que 3. A escala mais próxima é Material Design 3, distância 0,17. Medidos: 23. Julgados: 0. Gravidade alta 11, média 12. A nota de falha é a de achado alto confirmado. Sem baseline aprovada.

Notas visuais do examinador e do revisor: o relatório não tem a seção Crítica visual. A nota geral repete que o JSON das três telas não veio válido.

A causa está fora do produto. O Claude da conta respondeu `Failed to authenticate: OAuth session expired and could not be refreshed`. O access token do arquivo da conta expirou em 2026-11-11. O arquivo ainda guarda um refresh com data de cliente até 2026-12-06, e o provedor recusa renovar essa sessão. Uma cópia gravável do mesmo arquivo, com `CLAUDE_CONFIG_DIR` apontando para ela, na imagem nova do worker, devolveu a mesma frase. O arquivo original permaneceu com data de 2026-11-10 e 3343 bytes. Uma sonda anterior, numa cópia temporária que depois foi apagada, tinha autenticado; o refresh que o provedor aceitaria ficou nessa cópia. Outra chamada repetiria a recusa. O caminho do produto para entrar de novo é `npm run gateway -- account-add`. Não houve sexta corrida do exame.

### 3. Criar real

```
npm run personal:design -- criar /home/app/srv_projetos/workspace/ac-smoke-data/installation.json 324be55d-b879-4314-a387-578fb299a7b4 --briefing /tmp/design-create-briefing.md --telas 2 --rodadas 1
```

Código 1. A CLI imprimiu "O pedido de criação não tem telas ou rodadas válidas." Os valores 2 e 1 passam na leitura dos argumentos. O job `cb251ff7-0590-4271-a0df-9bd8904f59ed` saiu com `EXECUTION_NATIVE_FAILED`, saída vazia e tokens nulos. A leitura do pacote trata essa saída vazia como `DESIGN_CREATE_INVALID`. O diretório `/home/app/srv_projetos/workspace/ac-smoke-data/design-criacoes/ca8dad97-8056-452c-9d5b-01e2e1c91a75` ficou vazio. Não há HTML, exame das telas criadas nem vitrine. A causa é a mesma recusa de refresh do provedor.

### 4. Evidências

Em `docs/validation/evidence/design/` estão `exame-e13b3e7f-README.md`, `exame-e13b3e7f-cobertura.md`, `exame-e13b3e7f-cobertura-ferramentas.md` e `LEIA-ME.md`. O `LEIA-ME.md` registra que essa cópia mede ferramentas e tokens e não traz notas visuais. Não há relatório de criar nem vitrine para copiar. Nenhum print entrou. O JSON bruto de achados de imagem, 620249 bytes, ficou na instalação de teste.

### 5. Login no laboratório

Commit `b7e2423c`. A imagem é `localhost:5000/ac-design:reconstrucao@sha256:7320bb1b49eda069fb66da92455769abb2cbf5716adefcbb655ea332523cd3b0`. O fixture tem o formulário em `/`, o POST `/entrar` e a rota `/conta`. A captura logada da home difere da anônima. `/painel` continua com a nota de logado não capturado, porque o config não declara esse estado nessa rota.

O teste `tests/design-lab-image.test.ts` com `AC_DESIGN_LAB=1` passou 1, falhou 0, `duration_ms` 382569, código 0. O `storageState` saiu no modo 0600, escrito pelo uid 65532. A senha do laboratório não aparece no relatório nem nos brutos. Os controles do formulário medem 44 px, e o alvo plantado de 30 px continua sendo o medido.

`npx tsc --noEmit`: código 0.

### Suíte oficial

`umask 022 && env -u NO_COLOR -u FORCE_COLOR npm test`, com `AC_TEST_DATABASE_URL` no Postgres descartável `ac-design-r3-pg` (`127.0.0.1:54333`, banco `ac_implementation_test`).

Durou 694 s, código 0. Resumo: `{"passed":232,"failed":[],"excluded":87}`. `design-prepare.test.ts` (9 s), `design-serve-static.test.ts` (2 s) e `design-lab-image.test.ts` (2 s, pulado sem `AC_DESIGN_LAB`) estão entre os 232. `workflow-runtime-bootstrap.test.ts` (17 s) também. `npm test` reescreveu `docs/validation/evidence/runtime-result.json`. O arquivo foi restaurado para o blob `3ae5a15c9eeba482ac89eb790809df1aee81edef` e não entra no commit.

### Commits

| Item | Commit | O que entra |
|---|---|---|
| 1. preparar | `64ff4ea7`, `6e8fccef` | comando, testes e o texto do catálogo depois da gravação |
| 2. HTML do `--servir` | `8c7d2f53` | as telas servidas entram no exame |
| 3. Login | `b7e2423c` | storageState na imagem, captura logada e o alvo de 30 px |
| Fechamento | este commit | evidências do exame medido e esta seção |

O arquivo `upstream/happier/apps/server/generated` continua fora do git.

### O que não ficou pronto

As notas visuais reais do examinador e do revisor Claude não saíram. A sessão OAuth expirada não foi renovada pelo provedor.

As telas criadas, o exame dessas telas e a vitrine não saíram. O diretório `ca8dad97-8056-452c-9d5b-01e2e1c91a75` está vazio.

Não houve push. A instalação viva, o gateway vivo, o banco `ac_ispagent` e o contêiner `ac-personal-pg` não foram alterados.

## Reconstrução, rodada 4

Feita em 18/11/2026 no ramo `task/design-r3-image-proof`. A ordem está no commit `7bbc5414`. Os itens abaixo fecham em `976f531a` e `f93078ce`.

### 1. Login do exame

Commit `976f531a`. Antes de montar a cópia, o host lê só o `expiresAt` da conta Claude reservada. Se resta menos que o tempo máximo do exame mais 10 minutos, renova pelo caminho gravável da conta, a mesma chamada mínima que já renovava no lugar. O arquivo da conta recebe o refresh novo em escrita atômica, modo 0600, com o mesmo dono. Se a renovação falha, o exame recusa `EXAM_LOGIN_STALE` antes da cópia. O relatório e as CLIs de design e de verificação pedem para entrar de novo: `npm run gateway -- account-add`.

Depois do exame, o worker compara o `.credentials.json` da cópia com o original montado. Se mudou e o JSON é da mesma conta, com `claudeAiOauth` e os mesmos escopos, devolve só esse arquivo pelo canal de saída já assinado. O host grava de volta na conta, modo 0600, e retira o campo do resultado. JSON inválido ou outra conta não grava. A cópia do login continua. `/account` continua `:ro` dentro do exame.

Os testes usam credenciais falsas. Login vencido chama a renovação. Renovação que falha recusa `EXAM_LOGIN_STALE`. Cópia alterada da mesma conta volta para o arquivo. JSON inválido ou outra conta não grava.

### 2. Falha do modelo

Commit `f93078ce`. `cobertura.md` ganha a tabela com as colunas Papel, Modelo, Telas pedidas, Telas julgadas e Falha, nas linhas examinador e revisor. O README ganha a seção "Cobertura do exame". A frase `Failed to authenticate` vira `PROVIDER_AUTH_FAILED`, sem a frase e sem token. Se `scoreVisual` foi pedido, havia tela e nenhuma foi julgada, o relatório fica gravado e a CLI sai com código 1: "A crítica visual foi pedida e nenhuma tela foi julgada." No criar, resposta vazia ou falha do modelo vira `DESIGN_CREATE_MODEL_FAILED` com a causa. Um JSON que não é pacote de telas continua `DESIGN_CREATE_INVALID`. Um job nativo em estado failed aposenta o contêiner e o worker de design recusa com o código da falha.

### 3. Prova

`npx tsc --noEmit`: código 0.

`umask 022 && env -u NO_COLOR -u FORCE_COLOR npm test`, com `AC_TEST_DATABASE_URL` no Postgres descartável `ac-design-r3-pg` (`127.0.0.1:54333`, banco `ac_implementation_test`). Durou 702 s, código 0. Resumo: `{"passed":234,"failed":[],"excluded":87}`. `exam-login.test.ts`, `design-model-failure.test.ts`, `design-examine.test.ts` e `verify-exam-worker-mount.test.ts` estão entre os 234. `design-lab-image.test.ts` entra pulado, sem `AC_DESIGN_LAB`. `npm test` reescreveu `docs/validation/evidence/runtime-result.json`. O arquivo foi restaurado para o blob `3ae5a15c9eeba482ac89eb790809df1aee81edef` e não entra no commit.

Uma corrida anterior da mesma suíte, com o laboratório e o build da imagem ao mesmo tempo, falhou só `completed-node-recovery.test.ts` no limite de 30 s. Esse arquivo, sozinho, passou 9 e falhou 0. A suíte de 702 s é a registrada.

O teste `tests/design-lab-image.test.ts` com `AC_DESIGN_LAB=1` passou 1, falhou 0, `duration_ms` 398432, código 0.

A imagem do worker foi reconstruída só para `ac-native-execution`, com `scripts/prepare-native-execution-image.mjs` e `docker build -t ac-native-execution:personal`. Digest `sha256:b0e1e0ce798c11da5e290b54d2a9b3bb6b0a991411d36f4b92d28e298086c596`. A imagem anterior do worker, `sha256:48270d13109118edc9a6679646e7344ff8f29bfa9676c1d65889c2a95e93057a`, continua no disco. O planning continua `sha256:8c9b7d04e9fffc0f495fadb4f616ee8d158075af7ffb6428377fa205fcb95c64`. As tools continuam `sha256:9a1fa0650e34b7e5421411264be3b1490b3ee9676ff982e89148f888ab31142b`. Não houve `personal:setup` nem `personal:images`. Nada da instalação viva foi reiniciado.

Não houve exame real com modelo.

### Commits

| Item | Commit | O que entra |
|---|---|---|
| 1. Login do exame | `976f531a` | renovação no arquivo gravável e a rede de segurança da cópia |
| 2. Falha do modelo | `f93078ce` | cobertura do examinador e do revisor, CLI e criação |
| Fechamento | este commit | esta seção |

### O que não ficou pronto

As notas visuais reais e um exame com login válido ficam para o gerente, com uma conta que ainda entra. Esta rodada deixa o produto renovar o login no arquivo da conta antes da cópia e sair com código diferente de 0 quando o modelo não julga a tela.

Não houve push. A instalação viva, o gateway vivo, o banco `ac_ispagent` e o contêiner `ac-personal-pg` não foram alterados. O diretório `upstream/happier/apps/server/generated` continua fora do git.
