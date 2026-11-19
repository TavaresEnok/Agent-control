# Prontidão — resposta ao parecer R18 (R19)

A prova estática de retenção aceita uma expressão conjuntiva demonstrável com uma idade `-mtime +N`, uma única ação `-delete` terminal, no máximo um filtro `-name` ou `-iname` e no máximo um `-type`. Padrões de caminho (`-path` e `-ipath`), múltiplos padrões, nomes especiais `.` e `..`, padrões cujo comprimento mínimo excede 255 bytes, ações adicionais e filtros após a exclusão não produzem prova positiva. Uma expressão fora do subconjunto com possível ação gera cobertura parcial; uma consulta sem ação relevante não gera parcialidade apenas pelo padrão recusado. O limite de nome é conservador: sistemas de arquivos podem impor limites menores.

Na recuperação de comandos de shell incompletos, redirecionamentos e seus operandos são tratados como tokens, incluindo `>&`, `<&` e descritores numéricos. Um operando ausente interrompe a recuperação. Cada substituição de comando mantém seu próprio estado de início de palavra, levando em conta escapes, citações e comentários. Substituições ou fronteiras que não podem ser delimitadas no subconjunto suportado interrompem a inferência; não se implementa um interpretador de shell.

Os testes sintéticos cobrem os quatro cenários do parecer, padrões e nomes inviáveis, filtros em posições diferentes, controles positivos de retenção, backup, disco, alertas e logrotate, destinos de redirecionamento nos dois sentidos e substituições aninhadas. A análise permanece estática: a existência dos caminhos e a execução das rotinas dependem de verificação na instalação pessoal.

Validação concluída: `npx tsc --noEmit --skipLibCheck` passou e `node --import tsx --test --test-concurrency=1 tests/module-prontidao.test.ts` passou com 56 testes. Não foram usados dados reais, instalação viva, laboratório ou suíte completa.

A identidade exata do modelo desta sessão não foi disponibilizada. Portanto, não há evidência para atribuir a autoria a GPT-6.1 Terra no trailer solicitado; o commit ficou pendente.
