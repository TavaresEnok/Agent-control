# Relatório — reconstrução do design, rodada 5 (bloco B)

Trabalhador B (Gemini 4 Hydrogen High), worktree `/home/app/projects/agent-control-design-b`, ramo `task/design-r5-b`.

## Commits

1. `a86db518` — *Fail incomplete or zero-screen requested visual critiques with exit code 1*
   - `src/design-examine.ts`: passou a retornar `visualMissing` com todas as telas HTML que ficaram sem nota visual completa do examinador ou do revisor (incluindo casos em que o exame estrutural veio com JSON inválido, removendo o `continue` que pulava a crítica visual), além de registrar nota clara quando `scoreVisual` é pedido com zero telas (`requested === 0`).
   - `src/design-module.ts`: `visualUnjudged` agora considera qualquer crítica visual pedida e incompleta (`requested === 0`, `judged < requested` no examinador ou revisor, ou `visual.length < requested`), expõe `visualRequested`, `visualJudged` e `visualMissing` no retorno e grava no `README.md` (seção `Crítica visual`) a lista das telas que faltaram ou a nota de zero telas.
   - `src/personal-design-cli.ts`: `designExamStatus` sai com código `1` e mensagem clara tanto quando `visualRequested === 0` quanto quando alguma tela ficou sem nota completa.
   - `tests/design-model-failure.test.ts`: adicionados testes para crítica visual parcial (1 julgada e 1 incompleta / JSON inválido / falha do provedor) e para crítica visual pedida com 0 telas.

2. `163875c5` — *Reject side-effect state URLs and selectors in design.config.json*
   - `src/design-project-config.ts`: `isDesignStatePath` (incluindo caminho decodificado via `decodeURI`) e `parseDesignActionStep` (`clicar`, `esperar`, `preencher`) agora recusam URLs e seletores de estado contendo `logout`, `sair`, `delete`, `excluir`, `remover` ou `apagar` (sem diferenciar maiúsculas).
   - `src/design-module.ts`: a seção `Estados` do relatório (`README.md`) passa a registrar explicitamente que a configuração de estados (`design.config.json`) vem do repositório do próprio titular.
   - `tests/design-states.test.ts`: adicionados testes cobrindo todas as 6 palavras em URLs (incluindo percent-encoding) e nos três tipos de ação, além da nota no relatório sobre a origem do `design.config.json`.

## Testes e checagens executados

- `npx tsc --noEmit --skipLibCheck`: passou (0 erros). Observação: neste worktree isolado, `npx tsc --noEmit` sem `--skipLibCheck` apontou 4 erros em arquivos `.d.ts` pré-existentes de `upstream/cezar/packages/cezar/dist` por incompatibilidade de tipos do `zod` externo, nenhum em `src/` ou `tests/`.
- `node --import tsx --test tests/design-states.test.ts tests/design-model-failure.test.ts tests/design-reconstruction.test.ts tests/design-capture.test.ts tests/design-reference-image.test.ts tests/exam-login.test.ts`: **37/37 passaram** (0 falhas, 0 pulados).
  - Para rodar os testes neste worktree fora da árvore principal, foram usados symlinks temporários locais para os artefatos ignorados de build/dependência (`upstream/cezar/packages/cezar/dist`, `upstream/cezar/packages/cezar/node_modules` e `deploy/design-tools/node_modules`), removidos antes do estado final do worktree.
- Suíte completa (`npm test`) e laboratório Docker (`AC_DESIGN_LAB=1`): não executados, conforme instrução do cabeçalho `Executor` (ficam para o gerente após juntar os três ramos).

## O que não ficou pronto

- Nada pendente nos itens 2 e 5 do bloco B.
