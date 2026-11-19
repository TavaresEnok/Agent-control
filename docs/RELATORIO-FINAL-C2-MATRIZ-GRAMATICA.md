# C2 · Gramática das referências de requisito

A matriz lê cada oração antes de vincular uma operação. A gramática reconhece lista declarada no início do requisito, verbo ou rótulo de operação seguido de referência qualificada e sujeito qualificado de `retorna` ou `devolve`. A leitura exige o fechamento dos delimitadores e considera o texto adjacente. Referências em prosa fora da gramática mantêm a linha com cobertura limitada, mesmo quando um teste aprovado menciona o código do requisito e chama uma função homônima.

- `REQ-163` e `REQ-164` mantêm `OK` como contexto quando o papel de valor esperado aparece após a referência ou quando a referência integra uma descrição da mensagem de sucesso. Os controles cobrem qualificadores internos, externos e separados por vírgula, além de parênteses incompletos.
- `REQ-165` e `REQ-166` comprovam `primeira` em três passadas. O primeiro usa `deve-se calcular com` após uma oração introdutória. O segundo inclui `a saída esperada` como objeto de `calcular`.
- `REQ-167` mantém o vínculo comprovado com `primeira` e a cobertura limitada pela menção qualificada a `OK`. A regressão também cobre `and` e o par de operações em que só uma referência tem qualificador adjacente.
- As duas fixtures de faturamento passaram a usar a lista declarada no início da linha. Seus códigos, caminhos, alvos e descrições foram preservados. O guia `docs/USO-PESSOAL.md` registra as formas aceitas, a cobertura resultante e a sintaxe legada que continua disponível.

## Verificações

- O teste focal com as novas fixtures falhou em `50ac4590` ao encontrar cobertura limitada para `REQ-165`.
- `npx tsc --noEmit --skipLibCheck`, `node --check deploy/modules/qa/collect.mjs` e `git diff --check` passaram.
- `env -u AC_MODULE_LAB -u QA_SYNTHETIC_PROOF -u QA_MODULE_RUNTIME node --import tsx --test tests/module-qa.test.ts` teve 40 aprovações e 1 caso pulado, condicionado à prova privada. A regressão da matriz usa três passadas com fontes e testes sintéticos em diretórios temporários.
