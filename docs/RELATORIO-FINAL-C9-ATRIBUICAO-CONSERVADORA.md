# C9 — Atribuição estática conservadora de origem

Os coletores locais de JS/TS e Python registram a origem de um achado quando identificam um fluxo possível do campo até o argumento do log ou da escrita. Um resultado de chamada sem vínculo demonstrável fica sem linha de origem. Quando o resultado é usado, o coletor registra cobertura parcial mesmo em chamadas sem argumentos rastreáveis.

| Caso | Comportamento verificado |
| --- | --- |
| Método chamado por alias | O resumo segue receptores e referências de método identificáveis no mesmo arquivo. Se uma chamada pode substituir o vínculo do log ou do armazenamento, o coletor invalida esse vínculo. A chamada de um método Python extraído de um contêiner pode invalidar também o receptor guardado pelo método. |
| Mutação com parâmetro padrão | Em JS/TS, o resumo considera a expressão padrão no ponto da chamada quando o argumento pode faltar ou ser `undefined`. Em Python, a chamada usa a referência guardada na definição. As fixtures distinguem argumento explícito, omissão e reatribuição do nome original. |
| Junção com o mesmo contêiner | Ramos que devolvem ou atribuem a mesma referência preservam a identidade e o campo, inclusive para leituras posteriores por alias. Se as referências divergem, o resultado estruturado fica opaco e uma mutação posterior pelo resultado invalida os contêineres candidatos. |
| Curto-circuito com constante | Os coletores pulam o operando inalcançável dos operadores lógicos quando conhecem a condição relevante. A fixture confere tanto a ausência de achados no operando descartado quanto a preservação do destino e do valor lidos depois. O caso de `??` também distingue zero de `null`. |

Os efeitos são resumos de vínculos, chamadas e referências na AST local. Um efeito sem atualização precisa pode invalidar um contêiner inteiro e os valores mutáveis alcançáveis. Leituras escalares anteriores e contêineres independentes continuam disponíveis. Chaves dinâmicas, efeitos condicionais e resultados opacos podem deixar lacunas explícitas. A análise usa somente a árvore sintática e os modelos dos coletores, sem execução do código examinado.

Os testes usam somente dados sintéticos. Conferem tipo do destino, linha de destino, linha de origem, motivos de cobertura parcial e ausência de nomes e valores das fixtures na saída. Em dois testes anteriores, os pares de destino e origem foram mantidos e a cobertura agora indica as chamadas cujo resultado fica opaco. [Testes de conformidade](../tests/module-conformidade.test.ts)

## Verificação local

- `npx tsc --noEmit --skipLibCheck`
- `node --import tsx --test tests/module-conformidade.test.ts` — 29 testes
- `git diff --check`
