# C9 R7 — origens e destinos ao longo do fluxo

| Caso do parecer R6 | Resultado |
| --- | --- |
| Escrita em propriedade | JS/TS e Python usam o último valor escrito por chave ou índice literal. Aliases locais do mesmo objeto enxergam a atualização. Os testes cobrem introdução de origem, substituição por valor neutro, remoção e acesso a um objeto aninhado. |
| Destinos homônimos | O analisador consulta o vínculo corrente da função ou do receptor antes de classificar. Funções locais, métodos de objetos locais e métodos substituídos ficam sem a categoria do homônimo. Aliases do destino reconhecido preservam a categoria. |
| Expansão em Python | `**` em dicionário usa as entradas conhecidas na ordem de sobrescrita. `*` em argumentos e sequências usa as posições conhecidas. Expansões indeterminadas geram cobertura parcial. O rastreamento mantém entradas identificáveis, inclusive chaves conhecidas escritas após uma expansão opaca. |
| `EXPLAIN` | O plano simples fica sem achado de escrita. Com execução habilitada, o analisador aplica à instrução interna as regras de atribuição SQL. Opções ou instruções executadas fora do recorte e parâmetros ausentes geram cobertura parcial. [Documentação do PostgreSQL](https://www.postgresql.org/docs/current/sql-explain.html) |
| Origem Python multilinha | O acesso por colchetes usa a linha da chave. O acesso por atributo usa a linha do nome do atributo. A localização do destino continua sendo a linha inicial da chamada. |

As fixtures novas usam campos, objetos e valores inventados. Elas conferem a categoria do destino e o par de linhas de origem e chamada, inclusive a ausência de achados nos controles negativos. Os testes também verificam que o JSON omite nomes de campos, valores e comandos das fixtures. [Testes locais](../tests/module-conformidade.test.ts)

## Limites de cobertura

O vínculo é local ao arquivo. Operações convencionais sobre nomes externos sem declaração local e declarações ambiente em TS continuam sendo indícios. O analisador reconhece imports explícitos de uma lista restrita de módulos e seus aliases sem resolver dependências. Classes, chamadas opacas, vínculo dinâmico, efeitos entre funções e ordem de execução de callbacks limitam o que a análise pode determinar.

O rastreamento de mutações cobre o trecho linear e acessos literais. Reatribuições em ramos ou laços, chaves dinâmicas, sequências de tamanho incerto e chamadas opacas que recebem estruturas rastreadas podem tornar o estado parcial. O recorte SQL continua limitado a `INSERT` e `UPDATE` literais com parâmetros diretamente atribuídos, incluindo o `INSERT … SELECT` da CTE simples de `VALUES`. Qualquer motivo emitido na cobertura usa texto fixo.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-conformidade.test.ts` passou com 24 testes.
- `git diff --check` passou.
