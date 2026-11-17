# Verificação de design do painel

Data da execução: 2026-11-17. Alvo: o pacote `upstream/cezar/packages/web`, servido em `http://127.0.0.1:4173` a partir dos arquivos emitidos pelo build. Não houve login, não houve chamada à API nem ao gateway, e não há dado pessoal nem segredo nestas capturas.

## Build

`npm run build -w @open-mercato/cezar` no workspace `upstream/cezar` compilou o servidor. O build do Vite do painel transformou 3175 módulos, emitiu `packages/cezar/web/dist` e falhou em 2,35 s:

`Error: [vite]: Rolldown failed to resolve import "@happier-dev/protocol"` a partir de `upstream/happier/apps/cli/src/auth/terminalProvisioningResponse.ts`.

O pacote `@happier-dev/protocol` é privado, o `dist` dele não existe neste worktree e as dependências do Happier não estão instaladas. O `vite.config.ts` não foi alterado. O JavaScript emitido ficou com um import nu: `assets/index-D5leAlf5.js` (1 161 972 bytes) contém uma ocorrência de `@happier-dev/protocol`. O CSS emitido é `assets/index-DN7oXYmE.css` (171 081 bytes). O `index.html` tem 6 339 bytes e o título `cezar`.

## O que o navegador mostrou

Um servidor estático entregou esse `dist` em `127.0.0.1:4173`. `GET /`, `GET /tasks`, o JS e o CSS responderam 200, com os tamanhos acima.

O Chrome headless (`--dump-dom` em `/`) devolveu `<title>cezar</title>` e `<div id="root"></div>` vazio. O React não montou. As três capturas de página inteira são a tela preta desse documento vazio, no tema escuro padrão da página sem conteúdo:

| Arquivo | Viewport |
|---|---|
| `docs/validation/design-painel/inicio-375.png` | 375×812 |
| `docs/validation/design-painel/inicio-768.png` | 768×1024 |
| `docs/validation/design-painel/inicio-1440.png` | 1440×900 |

![Início em 375 px](design-painel/inicio-375.png)

![Início em 768 px](design-painel/inicio-768.png)

![Início em 1440 px](design-painel/inicio-1440.png)

## Ferramentas presas no lockfile

As versões são as de `deploy/design-tools/package.json`: Stylelint 18.0.0 e pa11y 10.0.0 (runner axe). O `npm ci` dessas ferramentas usou `--legacy-peer-deps`. O postinstall do Puppeteer foi bloqueado pelo npm; o Chrome usado foi `/usr/bin/google-chrome`.

Stylelint, com as regras `block-no-empty` e `color-no-invalid-hex`, leu `packages/web/src/styles/index.css`. O JSON resultante tem `errored: false`, `warnings: []` e `parseErrors: []`.

pa11y com o runner axe em `http://127.0.0.1:4173/` saiu com código 0 e corpo `[]`. O documento não tem controles.

## Exame do código pelo módulo

`runDesignModule` rodou com ativação `personal`, projeto `painel-cezar`, URL `http://127.0.0.1:4173`, commit `worktree` e `createdAt` `2026-11-17T04:10:00.000Z`. O worker foi `designBenchWorker`: examinador `claude` / `bancada-especialista` e revisor `grok` / `bancada-revisor`, os dois locais. Não houve chamada paga nem examinador multimodal.

Entraram 27 arquivos: `index.html`, `src/app.tsx`, `src/routes.tsx`, `src/styles/index.css`, as rotas `conversa`, `equipe`, `inbox`, `not-found`, `tasks-overview`, `novo-projeto`, `global-tasks`, `settings/settings-shell.tsx`, `settings/agent-control-section.tsx` e os `.tsx` de `src/routes/dashboard` (testes de fora). Os relatórios do Stylelint e do pa11y acima entraram como ferramentas. Não houve driver de captura dentro do módulo, então o mapa ficou com 0 capturas.

A descoberta leu 49 rotas no código. A lista aplicada tem 72 itens. O relatório saiu em `verificacoes/painel-cezar/20261117-041000-design`, execução `df8f17c1-852b-4e2b-b73e-40fddacd8eb6`: 25 achados brutos e 25 achados `ACH-001` a `ACH-025`, todos gravidade alta e situação confirmado.

| Regra | Quantidade |
|---|---|
| `ESTADOS-VAZIO-AUSENTE` | 20 |
| `WCAG-2-4-4-BOTAO-SEM-NOME` | 4 |
| `TOKENS-CINZAS-DEMAIS` | 1 |

A bancada confirma regra plantada, WCAG ou `DESIGN-`. Ela não descarta falso positivo do heurístico. A nota de falha do relatório (reprovado por achado alto confirmado) mede essa confirmação, não a tela pintada.

`ESTADOS-VAZIO-AUSENTE` dispara uma vez por arquivo que tem `.map(`, `data-list` ou `role=list` e não tem `data-empty`, o texto `Nenhum item` nem `empty-state` em lugar nenhum do arquivo. O primeiro caso é `src/routes.tsx:668`, `visibleSettingsSections(...).map`, um mapa de seções e não uma lista sem estado vazio.

`WCAG-2-4-4-BOTAO-SEM-NOME` só aceita `aria-label` entre aspas. Expressão JSX fica de fora:

- `src/routes/dashboard/layout.tsx:46` tem `` aria-label={`Move ${names[id]}`} ``.
- `src/routes/dashboard/trends.tsx:65` tem `aria-label={describe(point)}`.
- `src/routes/settings/settings-shell.tsx:303` tem `` aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`} ``.
- `src/routes/settings/settings-shell.tsx:334` não tem `aria-label`. O filho é `<ProjectRowLabel />`. O heurístico apaga a tag e não vê texto.

`TOKENS-CINZAS-DEMAIS` em `src/styles/index.css:213` lista 9 cinzas: `#171717`, `#1c1c1c`, `#262626`, `#a3a3a3`, `#7b7b7b`, `#ebebeb`, `#e5e7eb`, `#5c5c5c` e `#1b1c1d`. Os oito primeiros são tokens de tema. O nono é `rgba(27, 28, 29, 0.04)` de `--shadow-sm` na linha 319, normalizado para `#1b1c1d`. O limiar é 8 cinzas distintos, então o achado permanece com os tokens de tema.

## O que esta execução não mostra

A interface do painel não chegou a aparecer. Não houve exame visual das telas logadas, nem tema claro, nem estados forçados `vazio`, `carregando` e `erro` na navegação. A imagem `deploy/Dockerfile.design` não foi construída nesta máquina: o disco estava em 92% (25 GB livres) e a base do Playwright é grande. O digest pinado no Dockerfile é `sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579`.
