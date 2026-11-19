# C9 — Origem demonstrável nos fluxos locais

| Caso revisto em `52b078d2` | Comportamento verificado |
| --- | --- |
| Chamadas locais encadeadas | Os resumos seguem as declarações locais chamadas por nome, incluindo funções de seta em JS/TS. Uma escrita externa encontrada na cadeia invalida o destino no ponto da chamada inicial. |
| Alias local de um receptor externo | Uma escrita de membro por alias ou a passagem desse alias a uma chamada opaca invalida o receptor externo e os valores mutáveis alcançáveis. Uma leitura escalar anterior, um receptor independente e uma nova escrita explícita mantêm suas origens. |
| Escrita global durante a análise de outra função Python | Uma chamada interna pode invalidar um global atribuído no corpo em análise. O controle com um local homônimo preserva o próprio destino. |
| Junções e efeitos fora do modelo | Um ramo invalidado continua invalidado na junção. Resultados opacos e expansões incompletas só fornecem os campos cuja origem o analisador consegue demonstrar. Escritas descobertas em expressões fora do recorte passam pela junção conservadora e registram cobertura parcial. |

Os resumos usam possíveis vínculos lexicais do mesmo arquivo. Uma mutação pode invalidar o receptor inteiro, inclusive campos que a função talvez preserve. A resolução de aliases e chamadas se limita aos vínculos que o analisador consegue identificar no código local.

As fixtures conferem os pares de linhas de destino e origem, os controles com e sem achado e os motivos de cobertura parcial. O JSON continua sendo gerado e as asserções verificam a ausência dos nomes e valores das fixtures na saída. [Testes do módulo C9](../tests/module-conformidade.test.ts)

## Verificação local

- `npx tsc --noEmit --skipLibCheck`
- `node --import tsx --test tests/module-conformidade.test.ts` — 28 testes com dados sintéticos.
- `git diff --check`
