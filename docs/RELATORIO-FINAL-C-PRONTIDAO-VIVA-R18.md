# Prontidão viva — R18

Base: `b1d7aa05` neste worktree. Correção dos cinco pontos R17 por análise estática, com fixtures locais sintéticas.

- A prova de `find` aceita apenas padrões não vazios compostos de letras ASCII, dígitos, `_`, `.`, `+`, `-`, `*` e `?`. Caminhos com barra, classes, escapes e demais padrões ficam fora da prova; uma ação de retenção identificada na expressão torna a cobertura parcial. O parser não tenta decidir a satisfatibilidade geral das expressões.
- `-ok` e `-okdir` consomem argumentos até `;`; `-exec` e `-execdir` também aceitam `{} +`. Os operandos internos não se tornam ações externas.
- A recuperação de shell malformado delimita segmentos lexicais e usa os classificadores passivos existentes com os argumentos. Substituições de comando são opacas, sem execução ou expansão; construções cuja fronteira não é sustentada interrompem a recuperação. Consultas e argumentos de comandos de dados não se tornam operações.
- As regressões cobrem os cinco casos, terminadores das quatro ações, padrões aceitos e recusados, ausência de ação, wrappers, consultas, comentários e conteúdo citado ou de substituição. As asserções distinguem prova, ausência de evidência e cobertura parcial nos pilares; a contagem publicada de falhas é confrontada com a cobertura.

Validação: `npx tsc --noEmit --skipLibCheck`; `node --import tsx --test tests/module-prontidao.test.ts` (55 testes aprovados); após a última adição ao teste, `node --import tsx --test --test-name-pattern='R17:' tests/module-prontidao.test.ts` aprovado. Sem suíte completa, laboratório, imagens, instalação viva, logins ou serviços reais.
