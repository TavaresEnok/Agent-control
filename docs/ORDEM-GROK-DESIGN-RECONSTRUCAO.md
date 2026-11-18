# Ordem para o Grok — reconstrução do módulo de design

Escrita pelo gerente (Claude) em 18/11/2026. `grok-4.7`, esforço alto, **sem fast**, até 8 subagentes. Worktree `/home/app/projects/agent-control-design`, ramo `task/modulo-design`, que parte do ramo principal com os dois módulos juntos (6040bfcc).

## Por que existe esta ordem

O titular reprovou o módulo de design: "não deve ser algo amador, é um módulo que de fato entrega conteúdos incríveis". A inspeção do gerente mostrou:

- `deploy/design-entrypoint.sh` se declara "Esqueleto": devolve `findings: []`, só confere a versão do Lighthouse e do Stylelint, roda pa11y só na raiz e não converte o resultado.
- O módulo nunca executa a imagem `ac-design`; ela só é citada no relatório.
- `runDesignModule` recebe `tools`, mas `personal-design-cli.ts` nunca passa; `axeToFindings`, `pa11yToFindings`, `stylelintToFindings` e `lighthouseToFindings` não rodam em produção. Os 22 testes passam porque testam peças soltas.
- Não há design system de referência, extração de tokens, crítica visual de qualidade, comparação com referências, regressão visual nem modo de criar.

**Regra geral desta ordem:** nada de esqueleto, placeholder, "a fazer" ou ferramenta só listada. Cada ferramenta ou roda e seus achados chegam ao relatório final, ou o exame falha com código claro e a tabela de cobertura mostra a falha. Toda peça tem teste de ponta a ponta pelo caminho real (`runDesignModule` chamado como o CLI chama), não só da função isolada.

Commit por item, com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e trailer `Co-Authored-By: Grok 4.7 <noreply@x.ai>`. **Commite tudo.** Não toque na instalação viva (`/home/app/.agent-control/ispagent`), no gateway vivo, no banco `ac_ispagent` nem no contêiner `ac-personal-pg`. Não use Grok, Codex nem nenhum modelo seu para desenhar telas: telas são geradas pelo produto, com Claude Opus 5.5 médio (item 7).

Antes de começar, reaplique o commit `3b3cd9d4` (ramo `task/modulo-design-rodada3-extra`: seção do relatório com usuário, limites e rede da imagem), resolvendo o conflito com a rodada 6.

## 1. Medição de verdade (a imagem roda)

- O módulo executa a imagem `ac-design` (via `designRunArguments`, rede `design-homologation`, usuário 65532, limites atuais) para **cada rota descoberta × viewport (375, 768, 1440) × tema (claro e escuro quando houver `prefers-color-scheme` ou alternância)**.
- Dentro da imagem, um script Node real (não heredoc de esqueleto) usa Playwright do próprio contêiner e roda:
  - **axe-core** via `@axe-core/playwright` em cada página e viewport, com as tags `wcag2a, wcag2aa, wcag21aa, wcag22aa, best-practice`;
  - **pa11y** (runner axe e htmlcs) em cada URL;
  - **Lighthouse** (`lighthouse` programático ou `@lhci/cli collect`) por rota, categorias acessibilidade, boas práticas, performance e SEO, mobile e desktop;
  - **Stylelint** com a config de `src/design-stylelint.ts` sobre o CSS do repositório (`/repository`, só leitura);
  - **Project Wallace css-analyzer** sobre o CSS do repositório e sobre o CSS **computado** das páginas.
- A saída `achados-brutos.json` traz os relatórios reais; `personal-design-cli.ts` passa `tools` para `runDesignModule`, e os conversores existentes geram os achados.
- **Tabela de cobertura** no relatório: ferramenta, versão, rotas × viewports executados, achados, falhas. Ferramenta que falhou aparece como falha, nunca some.
- Atualize `deploy/design-tools/package.json` e o lock (versões fixas, sem `^`) para o que faltar (`lighthouse`, `pixelmatch`, `pngjs`, `style-dictionary` se usar dentro da imagem). Reconstrua a imagem com tag nova (`ac-design:reconstrucao`), registre o digest.

## 2. Design system e tokens

- Extraia os tokens **reais** de cada página renderizada (estilos computados de todos os elementos visíveis): famílias, tamanhos, pesos, alturas de linha, letter-spacing, cores de texto/fundo/borda, espaçamentos (margin/padding/gap), raios, sombras, durações de transição. Grave no formato **W3C Design Tokens (DTCG)** em `tokens.json` no relatório.
- Analise o sistema extraído:
  - **escala tipográfica**: razão entre tamanhos consecutivos, número de tamanhos (alerta acima de 7–8), pesos demais, famílias demais (> 2–3);
  - **espaçamento**: aderência à grade de 4/8 px, número de valores distintos;
  - **cor**: tamanho da paleta, cinzas quase iguais (ΔE2000 < 3), número de acentos, pares texto/fundo com contraste (WCAG 2.2 e APCA Lc como informativo);
  - **raio, sombra, movimento**: quantos valores distintos e se seguem uma escala.
- Compare com **referências de design system** gravadas como dados versionados em `deploy/design-references/` (JSON com fonte, URL e data de consulta, só valores numéricos e nomes de escala, sem copiar texto protegido): Material Design 3 (type scale, shape, elevation, spacing), IBM Carbon (spacing e type tokens), Shopify Polaris (space e font tokens), Apple HIG (tamanhos de texto dinâmico e alvos), GOV.UK Design System (escala tipográfica e espaçamento), Radix Colors (passos de escala). O relatório diz de qual escala o projeto mais se aproxima e onde foge.
- Achado de token tem medida estruturada (os campos de `DesignMeasure`) e pode ser `alta` só com medida.

## 3. Crítica visual (qualidade, não só conformidade)

- Novo conjunto de itens `VISUAL` no checklist, com texto **original** (não copie o texto das skills; leia as skills instaladas em `/home/app/.claude/plugins/synced/**/skills/{design-critique,design-elevation,design-systems,frontend-design,interaction-design}/SKILL.md` e os frameworks públicos como base de estudo). Cobertura mínima:
  - hierarquia visual (o olho vai primeiro ao que importa? um só ponto focal?);
  - tipografia (escala com contraste suficiente entre níveis, medida de linha 45–75 caracteres, pares de fonte coerentes);
  - cor (paleta coesa, acento usado só onde há ação, saturação e temperatura consistentes);
  - ritmo e espaçamento (proximidade agrupa, respiro proporcional à hierarquia);
  - grade e alinhamento (eixos comuns, bordas alinhadas);
  - densidade (informação por tela adequada ao uso);
  - consistência de componentes (mesmo botão, mesmo cartão);
  - marca e personalidade (identidade própria vs. "cara de template", clichês de UI gerada por IA: gradiente roxo genérico, cartões iguais, emoji como ícone, sombra em tudo);
  - polimento (ícones do mesmo conjunto e peso, estados de foco/hover, detalhes de borda e raio).
- O examinador dá **nota 0–10 por eixo** com justificativa ancorada no print (região/elemento) e o relatório mostra a nota por tela e a média. Nota abaixo de 7 em qualquer eixo vira achado com sugestão concreta (valor de cor, px, fonte, layout).
- O revisor (segundo Claude, conta ou sessão diferente) recebe o print e o código, não as notas do examinador, dá as próprias notas; divergência maior que 2 pontos num eixo vira nota de "julgamento incerto" no relatório.

## 4. Comparação com referências

- `--referencia <png|jpg>` (até 10) no CLI de exame e de criação. Arquivos copiados para o diretório privado do run (0600), nunca para o repositório.
- O examinador recebe as referências e o print lado a lado e pontua a distância em cada eixo da crítica visual ("a referência usa X, a tela usa Y"). Relatório com seção própria.

## 5. Regressão visual

- Cada run guarda as capturas por rota × viewport × tema em `<dataDirectory>/design-baseline/<projectId>/` (0700/0600), só após o titular aprovar (`--aprovar-baseline <runId>`).
- Runs seguintes comparam com **pixelmatch** (limiar configurável, padrão 0,1) e mostram no relatório: telas mudadas, porcentagem de pixels, imagem de diferença.

## 6. Estados e telas

- Além do estado padrão, capture estados declarados por rota em `design.config.json` do projeto (opcional): vazio, carregando, erro, logado; e o tema escuro. Sem declaração, o relatório diz "não capturado", não inventa.
- Rotas com `:param` usam os valores de exemplo do `design.config.json`; sem valor, são puladas com nota (como hoje).

## 7. Modo criar (Opus 5.5 médio)

- `npm run personal:design -- criar <instalação.json> <projectId> --briefing <arquivo.md> [--referencia ...] [--telas N] [--rodadas R]`.
- Reserva assento Claude com **modelo `claude-opus-5-5` e esforço `medium` forçados** (ignora o perfil da conta para este papel; recusa com código claro se a conta não tiver esse modelo).
- O modelo devolve, em JSON, `tokens.json` (DTCG) e N telas HTML/CSS autocontidas (fonte por `<link>`, sem base64, sem JS externo). O módulo grava em `<dataDirectory>/design-criacoes/<runId>/` (0700/0600), **nunca no repositório**, sem executar nada do que foi gerado fora do navegador do exame.
- Cada tela gerada passa pelo exame completo (itens 1–4). Telas com achado alto ou eixo visual < 8 voltam ao modelo com os achados e as medidas; até R rodadas (padrão 3). O relatório final mostra a evolução por rodada e uma vitrine `index.html` com as telas aprovadas e reprovadas.
- O exame de leitura continua só com Claude e com o mesmo isolamento (strip, `/account` `:ro`, cópia do login, wrapper, deny de leitura).

## 8. Prova

- **Fixture de laboratório** `tests/fixtures/design-lab-v2/` com defeitos plantados que cada ferramenta precisa achar: contraste baixo (axe), imagem sem alt (pa11y), CLS/LCP ruim (Lighthouse), regra de CSS proibida (Stylelint), 14 tamanhos de fonte e 9 cinzas quase iguais (tokens), alvo de 30 px, tema escuro quebrado, e uma tela "genérica" (gradiente roxo, cartões iguais) para a crítica visual. Teste de ponta a ponta: cada defeito aparece no relatório final com a ferramenta certa. Esse teste roda a imagem real (marque como lab se precisar de Docker, mas rode-o e registre o resultado).
- Teste de que nenhum campo da tabela de cobertura fica vazio e de que ferramenta quebrada aparece como falha.
- Teste do modo criar com examinador falso (bench) cobrindo o laço de rodadas e a escrita fora do repositório; e uma execução real curta (2 telas, 1 rodada) na instalação de teste `/home/app/srv_projetos/workspace/ac-smoke-data/installation.json`, registrada no relatório.
- `npx tsc --noEmit`, a suíte oficial (`env -u NO_COLOR -u FORCE_COLOR`, `umask 022`, `npm test`, `AC_TEST_DATABASE_URL` em `/ac_implementation_test` derivado da instalação de teste) e os testes de laboratório de design. Restaure `docs/validation/evidence/runtime-result.json` se a suíte o sujar.

## Fim

Relatório `docs/RELATORIO-GROK-DESIGN.md`, seção "Reconstrução": o que cada item entrega, commits, números da suíte, a tabela de cobertura do fixture, o digest da imagem nova, e o que **não** ficou pronto (dito com clareza, sem esconder). Atualize a seção do módulo 10 em `docs/MODULOS-DE-VERIFICACAO.md`. Tudo commitado.
