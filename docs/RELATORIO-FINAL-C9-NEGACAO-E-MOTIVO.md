# C9 — Negação composta e motivo exato do salto

Os controles sintéticos reproduziram a perda do achado posterior via `emit` em JavaScript e Python. Os coletores passaram a propagar o valor lógico conhecido de `!` e `not` nos resumos de funções locais e na análise da expressão. Quando o valor é conhecido, a análise ainda visita o operando e registra seus efeitos. A negação com operando sem valor lógico demonstrável mantém o tratamento conservador existente. [Coletor JavaScript](../deploy/modules/conformidade/lgpd_javascript.mjs) · [Coletor Python](../deploy/modules/conformidade/lgpd_python.py)

Os controles com `!(fixtureGate && false) || stop()` e `not (fixture_gate and False) or stop()` exigem cobertura `ok` e os dois achados `LOG` posteriores em cada linguagem, com linhas de destino e origem exatas. Os controles com `touch()` verificam separadamente que o lado esquerdo altera seu próprio emissor e que o emissor que seria alterado por `stop()` ainda gera o achado esperado. [Testes de conformidade](../tests/module-conformidade.test.ts)

O relatório físico da fixture `atribuicao/repo`, preservado em `/tmp/ac-retomada-8f5dddf3-JZR4mNOc/lab-conformidade-atribuicao.log`, registra `npm-license-policy` como `skipped` com o detalhe integral abaixo. [Registro da execução física anterior](RELATORIO-FINAL-C9-LAB-COBERTURA-PARCIAL.md)

> Lockfiles npm v2/v3 classificados: 0; erros: 0. Licenças ausentes permanecem desconhecidas.

O teste compara o texto por igualdade e rejeita o sufixo `Limite sintético atingido.`. Mantém os estados exigidos para as seis ferramentas, as três entradas de cobertura parcial e a comparação exata dos 16 achados da fixture. [Teste de laboratório](../tests/module-conformidade-lab.test.ts) · [Posições esperadas](../tests/fixtures/module-conformidade/atribuicao/expected.json)

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `env -u AC_MODULE_LAB node --import tsx --test tests/module-conformidade.test.ts tests/module-conformidade-lab.test.ts` aprovou os 32 testes executados.
- `git diff --check` passou.

A validação usou fixtures sintéticas e o relatório físico já disponível. Os três cenários de laboratório ficaram desativados.
