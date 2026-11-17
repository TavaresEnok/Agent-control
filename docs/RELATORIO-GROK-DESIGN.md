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
