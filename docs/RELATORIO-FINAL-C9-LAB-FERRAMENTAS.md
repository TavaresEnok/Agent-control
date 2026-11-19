# C9 — Cobertura agregada das ferramentas na fixture de atribuição

O teste exige exatamente uma linha agregada para cada uma das seis ferramentas esperadas em `atribuicao/repo`. O código de saída esperado continua sendo `1` por causa da cobertura estática parcial. [Teste de laboratório](../tests/module-conformidade-lab.test.ts)

| Ferramenta | Estado esperado | Motivo verificado para `skipped` |
| --- | --- | --- |
| `conformidade:snapshot` | `ok` | |
| `scancode-toolkit` | `ok` | |
| `presidio-analyzer` | `ok` | |
| `npm-license-policy` | `skipped` | Zero lockfiles npm v2/v3 classificados e zero erros. |
| `ort` | `skipped` | Nenhuma declaração SPDX elegível em lockfile npm. |
| `lgpd-static` | `failed` | |

A validação de `lgpd-static` mantém as duas lacunas esperadas. `operations.js` tem dois resultados de chamadas sem vínculo estático, `operations.py` tem um e `writes.ts` tem cobertura `ok`. A comparação de categoria, linha de destino e linha de origem continua verificando as 16 provas existentes. [Expectativas da fixture](../tests/fixtures/module-conformidade/atribuicao/expected.json)

Os controles sintéticos removem e duplicam cada linha agregada esperada e alteram o estado de cada ferramenta. Para os dois saltos esperados, também substituem o motivo. `com-defeito` e `limpo` exigem código `0` e as seis linhas agregadas com estado `ok`.

## Verificação

- `npx tsc --noEmit --skipLibCheck` concluiu com sucesso.
- `env -u AC_MODULE_LAB node --import tsx --test tests/module-conformidade-lab.test.ts` passou nos dois testes sintéticos. Os três cenários de laboratório ficaram desativados.
- `git diff --check` concluiu com sucesso.
