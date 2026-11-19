# C9 — Escopo dos efeitos na análise local de conformidade

| Caso do parecer sobre `93a8553c` | Comportamento verificado |
| --- | --- |
| Função local sem argumentos reatribui um destino externo | JS/TS e Python registram escritas explícitas em vínculos externos e aplicam a invalidação no ponto da chamada. As fixtures cobrem uma função intermediária, sombreamento, restauração do vínculo e, em Python, `global` e `nonlocal`. Uma cópia do destino lida antes da reatribuição continua vinculada ao destino anterior. |
| Reatribuição durante a composição de uma expressão em Python | Operandos são lidos na ordem da expressão. A concatenação, as interpolações, as tuplas e os dicionários conservam a origem lida antes de uma reatribuição posterior. |
| Receptor de atribuição aumentada em Python | O analisador obtém o receptor e a chave antes de avaliar o lado direito. A fixture distingue o objeto original do substituto com linhas de origem diferentes. Uma operação fora do recorte invalida o valor dependente e registra cobertura parcial. |
| Método sem vínculo estático | A chamada pode invalidar as propriedades do receptor rastreado, inclusive por aliases. As fixtures verificam chamadas diretas e por uma função intermediária, a preservação de uma leitura anterior e a recuperação após uma nova escrita explícita. |

## Limites

Os resumos representam possíveis efeitos lexicais no mesmo arquivo. Uma escrita externa marca o vínculo como indeterminado no ponto da chamada. Mutações incertas podem invalidar todo o receptor e objetos alcançáveis. A resolução de chamadas intermediárias se limita aos vínculos e membros diretos reconhecidos no ponto da análise. Aliases criados dentro de funções, retornos arbitrários, reflexão e ordem de callbacks estão fora desse recorte.

As verificações usam campos inventados e conferem categorias, pares de linhas de destino e origem, controles sem achado e motivos fixos de cobertura parcial. Asserções sobre o JSON verificam que ele omite os nomes e valores utilizados nos cenários. [Testes de conformidade](../tests/module-conformidade.test.ts)

## Verificação local

- `npx tsc --noEmit --skipLibCheck`
- `node --import tsx --test tests/module-conformidade.test.ts` — 27 testes.
- `git diff --check`
