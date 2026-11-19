# C9 — Cobertura parcial da fixture de atribuição

O laboratório físico de `fb99a576` registrou código de saída `1`, `stderr` vazio e JSON em `stdout` para `atribuicao/repo`. A rejeição do processo interrompeu o teste antes da leitura do relatório. O coletor sinaliza cobertura parcial quando o resultado de uma chamada é usado e a análise estática não demonstra o vínculo desse resultado. Cada registro `failed` de cobertura faz o coletor retornar `1`.

| Ferramenta | Arquivo | Cobertura observada | Causa |
| --- | --- | --- | --- |
| `lgpd-static:file` | `operations.js` | `failed` | Dois resultados de chamadas sem vínculo estático. A função de seta invocada na interpolação iniciada na linha 4 e o `.test` usado na condição da linha 9. |
| `lgpd-static:file` | `operations.py` | `failed` | Um resultado de chamada sem vínculo estático, a atribuição de `re.compile` na linha 3. |
| `lgpd-static:file` | `writes.ts` | `ok` | Os cálculos da fixture não produziram lacunas. |
| `lgpd-static` | Agregado | `failed` | Três arquivos examinados, dois com cobertura parcial. |

O trecho de `stdout` preservado em `/tmp/ac-retomada-8f5dddf3-JZR4mNOc/lab-conformidade-atribuicao.log` contém a cobertura completa e os 16 achados de destino. A comparação manteve a ordem e conferiu categoria, linha de destino e linha de origem contra `expected.json`. [Expectativas da fixture](../tests/fixtures/module-conformidade/atribuicao/expected.json)

| Arquivo | Destino ← origem |
| --- | --- |
| `operations.js` | `LOG` 1←1, 2←2 e 9←9. `NETWORK` 21←15. `STORAGE` 26←15. |
| `operations.py` | `LOG` 5←5, 7←6, 14←6 e 17←16. `STORAGE` 19←6. |
| `writes.ts` | `LOG` 3←2. `STORAGE` 5←2, 6←6, 7←4, 14←2 e 16←2. |

As contagens coincidem com a análise estática local das fixtures sintéticas. Substituir isoladamente cada chamada que contribui para a lacuna reduziu em uma unidade a contagem do respectivo arquivo. A chamada `.test` descartada no corpo da função de seta manteve a contagem ao ser retirada. Os achados e a cobertura observados correspondem ao contrato esperado.

O teste exige código `1` e exatamente os três registros `failed` acima para `atribuicao/repo`, com as causas e contagens por arquivo e cobertura `ok` para `writes.ts`. As comparações exatas de destino e origem continuam a verificar os controles negativos, e as verificações de supressão de dados continuam ativas. `com-defeito` e `limpo` continuam a exigir código `0` e rejeitam qualquer registro `failed`. [Teste de laboratório](../tests/module-conformidade-lab.test.ts)

## Verificação

- `npx tsc --noEmit --skipLibCheck`
- `env -u AC_MODULE_LAB node --import tsx --test tests/module-conformidade-lab.test.ts` — um teste unitário passou e três cenários físicos ficaram desativados.
- `git diff --check`

A execução física foi verificada pelo log existente. O laboratório e a suíte completa ficaram fora desta rodada.
