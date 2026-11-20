# Relatório R16 — prontidão passiva

A análise de `find` só reconhece retenção após percorrer toda a expressão no subconjunto estático de conjunções, com operandos completos e `-delete` precedido de filtro positivo de idade. Expressões fora desse subconjunto com ação possivelmente relevante tornam a cobertura parcial; ações de impressão isoladas não o fazem. Valores de predicados são consumidos mesmo quando parecem opções.

O reconhecimento de consultas e destinos PostgreSQL consome valores das opções antes de interpretá-los; `-?` é consulta. O processamento das opções globais restic preserva a posição após os valores já consumidos. O tratamento de `timeout` considera operandos anexados depois de opções curtas agrupadas. Na análise de `sh -c` malformado, alvos literais npm/pnpm identificados restringem a incerteza ao pilar pertinente.

Os testes usam repositórios temporários e binários simulados. O controle positivo verifica cobertura `ok` e o fato de retenção identificada, além do achado. A gramática é deliberadamente limitada: expressões fora dela não são convertidas em prova positiva.

Verificações: `npx tsc --noEmit --skipLibCheck`; `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts`. Não foram executados suíte completa, laboratório, reconstrução de imagens ou operações na instalação viva. A análise das rotinas permanece passiva.
