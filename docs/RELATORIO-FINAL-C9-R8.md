# C9 R8 — ordem de avaliação e cobertura parcial

| Caso do parecer R7 | Resultado verificado |
| --- | --- |
| Argumentos JS/TS relidos após reatribuição | O coletor registra o destino e cada valor no ponto da leitura. Uma propriedade lida antes da sobrescrita mantém sua linha de origem. A expansão de um array captura as posições no ponto da expansão. Um argumento que é o próprio objeto conserva sua identidade e reflete as alterações feitas nele antes da chamada. As regressões cobrem log, armazenamento local e SQL. Em Python, testam também reatribuições entre argumentos e expansão posicional. |
| Função local altera o argumento | Uma chamada com efeitos indeterminados invalida as estruturas alcançáveis pelos argumentos rastreados e marca cobertura parcial. Os aliases dessas estruturas passam a refletir a incerteza. Um valor lido antes da chamada e um objeto independente conservam suas origens. Uma função de corpo vazio ou equivalente nas fixtures deixa os argumentos intactos. |
| Função usa um destino reatribuído antes da chamada | JS/TS e Python analisam corpos de funções em escopos isolados. Quando a categoria depende de um vínculo externo cuja ordem de chamada é desconhecida, o coletor registra cobertura parcial. As fixtures verificam a troca de logger para função neutra e a direção inversa. Em JS/TS, o vínculo `const` de módulo para um destino já lido pode ser preservado quando o valor rastreado é estável. |
| Dois aliases do mesmo módulo | Imports do objeto default de `axios` e aliases de módulos Python reconhecidos compartilham a identidade correspondente no arquivo. A troca de um método aparece nas consultas feitas pelo outro alias. Um método guardado antes da troca continua representando o valor anterior. Em Python, `from ... import ...` lê o atributo no ponto da importação. |
| Alvo de `for…of` | A escrita no alvo entra na análise de fluxo repetido, incluindo propriedades acessíveis por alias. Após o laço, a origem anterior desses alvos fica indeterminada e a cobertura fica parcial. Os controles também cobrem `for…in` e uma sequência vazia, pois o coletor não calcula o número de iterações. |

## Recorte da análise

O vínculo permanece local ao arquivo. A análise visita a árvore sintática e usa referências abstratas para valores e objetos. Corpos de funções são examinados independentemente, sem propagar seus retornos ou escritas por globais e sem simular a ordem de chamadas ou callbacks. Vínculos externos potencialmente mutáveis podem gerar cobertura parcial mesmo quando o programa teria uma única ordem em uma execução concreta.

As fixtures usam campos e valores inventados. Elas conferem a categoria e o par de linhas de destino e origem, os controles sem achado e os motivos fixos de cobertura parcial. O teste também confere que nomes de campos, valores e comandos SQL das fixtures ficam fora do JSON do relatório. [Teste de conformidade](../tests/module-conformidade.test.ts)

## Verificação local

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-conformidade.test.ts` passou com 25 testes.
- `git diff --check` passou.
