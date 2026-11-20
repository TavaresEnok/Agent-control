# Prontidão — correção R16 (R17)

Base do trabalho: `9c057413`, neste worktree. A alteração trata os pontos do parecer de R16 sobre o diff de R15; não constitui prova de execução de scripts ou de produção.

## Resultado

- `find`: a prova positiva exige conjunção no subconjunto analisado, `-mtime +N` antes de `-delete`, operandos completos e tipos válidos em toda a expressão. Idades ou tipos duplicados retêm a prova e marcam cobertura parcial quando há ação relevante. Idades distintas de `-mtime`, predicados com semântica de operando não demonstrada e valores de idade acima de 365000 em valor absoluto também ficam fora da prova positiva. Padrões de nome e caminho permanecem literais. Ações de impressão com operandos e ações `-exec`/`-execdir`/`-ok`/`-okdir` consomem seus argumentos, sem reinterpretar palavras como ações externas.
- Em corpo malformado de `sh -c`, palavras completas anteriores ao ponto malformado são separadas apenas por operadores top-level; cada segmento contribui aos pilares possíveis, e o alvo literal de npm/pnpm limita somente seu próprio segmento. Separadores dentro de aspas não são recuperados como comandos.
- Controles sintéticos cobrem idades e tipos inválidos antes e depois da ação, duplicatas, retenção positiva, operandos de impressão, corpo malformado com dois comandos, alvo npm com opção e aspas, PostgreSQL `-N` com destino seguro e inseguro, timeout com sinal anexado e o par restic. A contagem do relatório é comparada às entradas de cobertura realmente falhas no caso de dois pilares parciais. A opção PostgreSQL `-S` continua fora do subconjunto declarado.

## Validação e escopo

- `npx tsc --noEmit --skipLibCheck`.
- `node --import tsx --test tests/module-prontidao.test.ts`, com fixtures locais sintéticas e executores substituídos nos cenários adicionados.
- Não foi executada a suíte completa, laboratório, strings dos projetos auditados, reconstrução de imagens ou acesso à instalação viva, contas ou serviços.
