# Ordem para o Grok — reconstrução do design, rodada 2

Escrita pelo gerente (Claude) em 18/11/2026. `grok-4.7`, esforço alto, **sem fast**, até 8 subagentes. Worktree `/home/app/projects/agent-control-design`, ramo `task/design-r3-image-proof` (HEAD `d5b2d3d3`).

A rodada 1 ligou a imagem ao relatório. Uma revisão independente (Claude Sonnet 5.5, só leitura) e a conferência do gerente acharam os defeitos abaixo, todos confirmados no código. A regra da ordem anterior continua: nada de esqueleto, nada inventado, ferramenta ou roda e seus achados chegam ao relatório, ou aparece como falha.

Commit por item, com `git -c user.name="Enok Tavares" -c user.email="migration@localhost"` e trailer `Co-Authored-By: Grok 4.7 <noreply@x.ai>`. **Commite tudo.** Não toque na instalação viva (`/home/app/.agent-control/ispagent`), no gateway vivo, no banco `ac_ispagent` nem no contêiner `ac-personal-pg`. Não desenhe telas com Grok nem com outro modelo seu.

## Altos

1. **Project Wallace chega ao relatório.** `interpretDesignImageDocument` ignora `reports.cssAnalyzer`. Converta o resultado em achados com medida: número de cores, tamanhos de fonte, famílias, `!important`, especificidade máxima e média, seletores por regra, declarações duplicadas, z-index distintos, unidades misturadas. Use limites documentados no código, por exemplo "mais de 8 tamanhos de fonte" ou "especificidade acima de 0,3,0". A coluna Achados conta achados, não folhas.
2. **Contraste com transparência.** `parseCssColor` lê `rgba(0,0,0,0)` como preto opaco e gera `DESIGN-TOKENS-CONTRASTE` alto falso.
   - Leia alfa em `rgb()`, `rgba()`, `#rgba`, `#rrggbbaa`, `transparent` e na sintaxe com espaço `rgb(0 0 0 / 0.5)`.
   - O fundo efetivo é a composição dos ancestrais até um fundo opaco. Para isso, o script da imagem precisa amostrar o fundo efetivo de cada elemento de texto, não o `backgroundColor` do próprio elemento.
   - Fundo com imagem ou gradiente vira "contraste não medido", não um achado.
   - Teste: texto escuro sobre um elemento transparente dentro de fundo branco não gera achado.
3. **Referências como imagem.** As referências do titular (`--referencia`) precisam chegar ao examinador como imagens, ao lado do print da tela, no exame e no modo criar.
   - Siga o caminho que o print já usa para chegar ao modelo.
   - O examinador pontua a distância por eixo e o relatório tem a seção "Referências".
   - Teste pelo caminho real: o pedido montado para o worker contém a referência como imagem.
4. **APCA.** `apcaLc` subtrai `loClip` (0,1) onde o SAPC 0.98G usa `loBoWoffset`/`loWoBoffset` 0,027. Preto sobre branco tem que dar cerca de 106, e branco sobre preto cerca de −108. Teste com esses dois pares e um intermediário.

## Médios

5. **Estados de verdade.** Remova o `?estado=` inventado.
   - Um estado só é capturado quando `design.config.json` declara como chegar nele:
     - `url`: caminho relativo ao alvo, mesmo host;
     - ou `acoes`: lista fechada de `clicar <seletor>`, `preencher <seletor> <texto>` e `esperar <seletor>`, sem JS livre.
   - **Logado** usa o login do host (`--login-file`): o host faz o login e gera um `storageState` 0600, montado só leitura e apagado no fim. A senha nunca entra no contêiner nem no relatório.
   - Sem declaração, o relatório diz "não capturado".
   - Teste: o servidor do laboratório devolve conteúdo diferente por estado, e as capturas diferem.
6. **Status HTTP.** Página com status ≥ 400 ou erro de navegação não conta como examinada. Ela vira uma linha "rota indisponível (status)" na cobertura e um achado `DESIGN-ROTA-INDISPONIVEL`.
7. **Executado = o que rodou.** A célula Executado conta as células que de fato terminaram, e Falha lista cada falha, até um limite, com o total.
   - pa11y roda por rota × viewport.
   - Lighthouse roda mobile e desktop separados, com o fator de forma no relatório.
   - Uma ferramenta que sai com 0 mas devolve JSON ilegível é falha.
   - Contêiner que sai diferente de 0 vira falha na cobertura, mesmo com JSON escrito.
   - Teste com uma ferramenta quebrada de cada vez (pa11y, Lighthouse, axe) mostra só aquela linha como falha.
8. **Achado medido não depende de confirmação do modelo.** Achado com medida estruturada (`DesignMeasure`) entra como confirmado pela medida: Lighthouse LCP/CLS/TBT, tokens, alvo menor que 24/44 px, contraste medido e Wallace.
   - O modelo continua confirmando os achados subjetivos e os sem medida.
   - O relatório separa "medido" de "julgado".
9. **Referências de design system completas.** Preencha `spacePx`, `typePx`, `radiusPx` e `elevation` em todas as referências em que a fonte publica esses valores; Material 3 tem escala de espaçamento de 4 em 4.
   - Use `colorSteps` do Radix na análise de paleta: número de passos por matiz e se a paleta tem rampa.
   - Referência sem um campo não pode ganhar por falta de penalidade: a distância é normalizada pelos campos comparados, e só entra na disputa a referência com pelo menos dois campos.
10. **HTML gerado no modo criar.** Troque o `stripGeneratedHtml` por regex por um sanitizador com parser (`parse5` ou similar, versão fixa).
    - Remova script, `on*`, iframe, object, embed, meta refresh, `<base>` e `javascript:`.
    - Remova URL externa em `src`, `href`, `srcset`, `@import`, `url()` e `//`; a única exceção é `fonts.googleapis.com`/`fonts.gstatic.com` em `<link>`.
    - Teste com cada vetor.
11. **Retrabalho no modo criar.**
    - A aprovação é por tela: só a tela reprovada volta.
    - O pedido de retrabalho leva o HTML anterior da tela, os achados com medida e as notas visuais.
    - `</head>` ausente é corrigido, não ignorado.
    - A vitrine mostra todas as rodadas, com a evolução das notas.
12. **Servidor do modo criar.** O modo criar não pode usar `serve-lab.mjs`, que atrasa `/` e `/hero.jpg` de propósito. Crie `serve-static.mjs` sem atrasos, só GET de arquivos da pasta, sem listar diretório, com tipos MIME corretos, e use-o no criar e no item 15.
13. **Supervisor.** O `model`/`effort` forçados valem só para o papel do modo criar de design numa instalação pessoal; qualquer outro pedido que os traga é recusado.
    - Confira que **a conta reservada** oferece `claude-opus-5-5`, não só o catálogo.
    - Registre no grant o modelo e o esforço efetivos.
    - O criar passa por `acceptClaudeExamSeat`.
14. **Diretório temporário.** Não use 0777. Rode o contêiner com `--user` igual ao dono do diretório, ou use um diretório 0700 do host com o dono certo, ou mantenha o 1777 só durante a escrita do contêiner e valide o dono e o modo de `achados-brutos.json` antes de ler. Escolha uma opção e explique no relatório.

## Uso real

15. **`--servir <pasta>`** no exame: sobe a pasta com `serve-static.mjs` na rede de homologação (como o criar) e examina `http://design-servir.local:8080`, descobrindo as páginas `.html` da pasta como rotas. É assim que o titular vai examinar telas estáticas (por exemplo `painel_provedores/html_app`). Alvo `localhost`/`127.0.0.1` sem `--servir` não alcança o host a partir do contêiner: recuse com o código `DESIGN_TARGET_UNREACHABLE` e uma mensagem que diga o que usar.

## Baixos

- Baseline por nome sem colisão (`/a-b` × `/a/b`, use hash da rota); `projectId` validado também em `baselineBuffer`.
- Referências com nomes que só diferem na caixa não quebram com erro cru.
- Escape de `|` e quebras de linha nas células da tabela de cobertura.
- `assertPasswordAbsent` cobre as seções novas e os arquivos extras.
- O teste de laboratório não escreve em caminho fixo de `/tmp`.
- Stylelint também sobre os `<style>` das páginas; sem CSS no repositório, a linha diz "0 arquivos do repositório, N blocos de página", não falha.
- O relatório mostra as notas do revisor ao lado das do examinador.

## Prova

- `tests/design-lab-image.test.ts` com a imagem real (`AC_DESIGN_LAB=1`), atualizado para os itens acima, inclusive:
  - estados reais;
  - rota 404;
  - Wallace;
  - contraste sobre fundo transparente sem falso positivo;
  - uma referência PNG.

  Rode-o e registre o resultado.
- Teste de ponta a ponta do `--servir` com uma pasta de 3 HTML estáticos.
- **Execução real do criar** (2 telas, 1 rodada) na instalação de teste `/home/app/srv_projetos/workspace/ac-smoke-data/installation.json`.
  - Os bloqueios de antes eram `CAPACITY_POLICY_REQUIRED` no contexto e `claude-opus-5-5` ausente do catálogo dessa instalação.
  - Resolva com os comandos do próprio produto (`npm run personal:*`, adição de conta ou modelo, política de capacidade), só nessa instalação de teste.
  - Se não houver comando do produto para isso, diga no relatório o que falta, sem escrever no banco à mão.
- Reconstrua a imagem (`ac-design:reconstrucao`, envie para `localhost:5000`) e atualize `deploy/design-image-digest.txt`.
- `npx tsc --noEmit` e a suíte oficial: `umask 022`, `env -u NO_COLOR -u FORCE_COLOR`, `npm test`, `AC_TEST_DATABASE_URL` em `/ac_implementation_test`. Restaure `docs/validation/evidence/runtime-result.json` se a suíte o sujar.

## Fim

Em `docs/RELATORIO-GROK-DESIGN.md`, adicione a seção "Reconstrução, rodada 2" com:
- cada item, com o commit;
- a tabela de cobertura do laboratório;
- os números da suíte;
- o digest;
- o que não ficou pronto, dito com clareza.

Tudo commitado.
