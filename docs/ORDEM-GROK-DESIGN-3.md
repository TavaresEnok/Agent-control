# Ordem para o Grok — módulo de design, rodada 3

Escrita pelo gerente (Claude) em 17/11/2026. `grok-4.7`, esforço alto, sem fast, até 8 subagentes. Corrige a revisão independente da rodada 2 (Sonnet, só leitura). Cada correção vem com um teste que falha antes e passa depois. Commit por item, com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e o trailer `Co-Authored-By: Grok 4.7 <noreply@x.ai>`. Não toque na instalação viva, no gateway vivo nem no banco `ac_ispagent`.

## 0. Base comum com o validador

Antes de tudo, faça `git merge refs/heads/task/validador-seguranca` neste ramo (`task/modulo-design`). O validador já isolou o exame de leitura em `src/native-execution-supervisor.ts` e `src/native-execution-worker.ts` (variável `AC_VERIFY_EXAM`, strip da cópia, `/account` `:ro` com cópia do login em tmpfs, wrapper `/tmp/ac-exam-claude.cjs` com `--setting-sources user` e sem `--mcp-config`). Resolva os conflitos mantendo os dois módulos funcionando. Rode `npx tsc --noEmit` e os testes `tests/verify-*.test.ts` e `tests/design-*.test.ts` antes do primeiro commit da rodada.

## Altos

**A1. Exame de design com a config do repositório.** O papel de design (`design-readonly-v1`, specialist e reviewer) roda o Claude com `cwd=/work` numa cópia que ainda tem `.claude/`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.codex`, `.grok`, `.cursor`, `GROK.md`, com `/account` gravável. Use **o mesmo mecanismo do validador** (não uma segunda implementação): o exame de design passa pelo mesmo strip, mount `:ro`, cópia do login em tmpfs e wrapper. Teste: repositório com `.claude/settings.json` cujo hook grava um marcador; o marcador não aparece e a conta fica intacta, para o comando de design.

**A2. Alto sem prova.** `missingEmptyStateFindings` (`src/design-discover.ts`) dá `alta` a qualquer `<ul>/<ol>` sem marcador de vazio; botão sem nome no código (`src/design-a11y.ts`) também sai `alta` sem medida; `highSeverityAllowed` (`src/design-types.ts`) aceita `alta` se a `reference` contiver "WCAG" ou "DESIGN-", texto que o próprio modelo escreve. Regra nova: `alta` exige uma **medida** no achado (razão de contraste medida, px do alvo, px de transbordamento, captura de estado vazio sem texto) em campo estruturado — não string. Estado vazio por padrão é `media`; lista com itens literais (navegação estática) não gera achado. Testes com `<ul><li><a href="/">Início</a></li></ul>` (nenhum achado) e com `.map` sobre dado dinâmico sem vazio (`media`).

**A3. Rota parametrizada capturada literalmente.** `/p/:projectId`, `/tasks/:id`, rotas com `*` foram abertas como texto e o `{"error":"AUTH_REQUIRED"}` virou alto confirmado. Pule rotas com `:param` ou `*`, salvo se houver valor de exemplo declarado; resposta JSON ou não-HTML é "não é tela", sem achado. Refaça `docs/validation/verificacao-design-painel.md` sem esse falso alto.

## Médios

**M1.** `stageDesignCapturesForJob` só quando o job é exame de design (hoje roda para todo job nativo, inclusive programador e modo travado).

**M2.** Capturas fora do repositório: diretório privado em `<dataDirectory>/design-captures/<runId>` (0700/0600), copiar só o `runId` atual, limpar também no início do próximo exame o que um kill deixou.

**M3.** Navegador do exame com rede restrita: `context.route('**/*')` bloqueando tudo fora da origem declarada; `assertDesignDestination` também na URL final após `goto` e após o login; o formulário de login só é preenchido se a página estiver na origem declarada. Teste com redirecionamento para outra origem.

**M4.** `design-readonly-v1` recusado nas rotas públicas de criação de intent (`src/contracts.ts` aceita); só o CLI do titular cria. Testes: o modo `locked` continua exigindo política; programador, qa e judge nunca usam o atalho `personalReadonlyExam`.

## Baixos

**B1.** `attributeCounts`: `\balt`/`\btitle` casam `data-title`/`aria-title`; spread `{...props}` deve tornar o nome "desconhecido" (sem achado alto); `aria-label` vazio não conta como nome.
**B2.** Marcador de vazio por bloco/componente, não global no arquivo.
**B3.** `personal-design-cli.ts`: código desconhecido imprime mensagem redigida.
**B4.** `readDesignRepository` pula `.claude/`, `.mcp.json`, `.codex`, `.grok`.
**B5.** Capturar o estado vazio quando a rota tiver um (ou registrar que não deu), e registrar no relatório a prova da imagem sem root, com limites e só na rede declarada.

## Fim

Rode `npx tsc --noEmit` e a suíte oficial (`env -u NO_COLOR -u FORCE_COLOR`, `umask 022`, `npm test`) e registre os números. **Commite tudo** (a rodada anterior do validador terminou sem commit; não repita). Acrescente "Rodada 3" a `docs/RELATORIO-GROK-DESIGN.md`.
