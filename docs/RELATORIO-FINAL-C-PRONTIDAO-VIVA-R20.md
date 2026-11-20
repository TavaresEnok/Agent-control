# Prontidão R20

Base deste worktree: `de78eb37` (a ordem identifica o titular como `43f1c664`). O trabalho ficou restrito ao coletor, aos testes sintéticos e a este relatório.

- Uma lista ordenada de redirecionamentos alimenta o léxico, o consumo de operandos e a recuperação. Os operadores `<>` e `>|` mantêm seus operandos; um operador sem operando não permite recuperar o segmento como prova.
- Substituições são opacas. A recuperação reconhece somente palavras simples, aspas, escapes, comentários e substituições aninhadas; operadores e sintaxe composta fazem parar antes da palavra afetada. Segmentos exteriores completos e prefixos inequívocos permanecem. O coletor documenta esse contrato e o subconjunto positivo para retenção por `find`.
- Espaço, tabulação e quebra de linha são separadores lexicais; espaços Unicode continuam parte da palavra. Quebras de linha após comentários preservam a fronteira seguinte.

Validação local com dados sintéticos: `npx tsc --noEmit --skipLibCheck` passou; `node --import tsx --test tests/module-prontidao.test.ts` passou (57 testes, incluindo R16, R17, R19 e R20); o teste R20 foi executado novamente após a ampliação dos controles e passou. Os casos incluem `case`, here-doc, sintaxe composta, conteúdo interno para os três pilares, redirecionamentos com e sem operando, espaços Unicode e separadores ASCII. Não houve revisão independente nesta execução. Não foram executados suíte completa, laboratório, reconstrução de imagens ou ações na instalação viva.
