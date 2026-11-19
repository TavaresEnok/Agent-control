# Conformidade C9 · Rodada 4

Base `c0bb5637`, que já contém a correção da triagem entre dependências por classes de expressão SPDX.

## Ajustes e controles sintéticos

- **Declarações tipadas e interpolações.** O rastreamento de JS e TS separa a anotação do inicializador e considera o código entre `${` e `}` em literais de modelo, inclusive em interpolações aninhadas. Texto comum, comentários e interpolações escapadas podem gerar menções informativas a campos. Os avisos de destino exigem um indício em argumento de chamada. Os controles verificam a linha da origem e a ausência de valores e trechos de código no JSON. [Analisador](../deploy/modules/conformidade/lgpd_analyzer.py#L70) · [Teste](../tests/module-conformidade.test.ts#L124)
- **Blocos e reatribuições.** O rastreamento resolve cada referência para a declaração visível mais próxima e atualiza essa declaração nas atribuições de blocos internos. Os controles verificam leitura de dois níveis, substituição por literal, nova atribuição com campo, sombreamento antes e depois da declaração local e preservação da origem externa após a saída do bloco. [Analisador](../deploy/modules/conformidade/lgpd_analyzer.py#L173) · [Teste](../tests/module-conformidade.test.ts#L177)
- **Limite de leitura.** A leitura de chamadas preserva indícios dos primeiros 4.096 caracteres dos argumentos e registra cobertura parcial `failed` por arquivo quando o fechamento ultrapassa esse limite. Os controles incluem campo direto e variável rastreada antes do corte, referência somente após o corte, identificador cortado e fechamentos no limite e um caractere depois. [Analisador](../deploy/modules/conformidade/lgpd_analyzer.py#L122) · [Teste](../tests/module-conformidade.test.ts#L213)
- **Pares SPDX.** A triagem ordena as expressões distintas de copyleft forte e proprietárias, examina até 256 pares e informa quantos ficaram fora do limite. O teste de `c0bb5637` confirma o par `GPL-2.0-only` e `GPL-3.0-only` na presença de `GPL-2.0-or-later` nas seis permutações, inclusive com repetição de expressão. O orçamento reduzido a um par confirma que o conjunto escolhido independe da ordem de entrada e que os dois pares restantes aparecem na cobertura. [Política npm](../deploy/modules/conformidade/license_policy.py#L142) · [Teste](../tests/module-conformidade.test.ts#L574)

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou com Node.js `22.23.4`.
- `node --import tsx --test tests/module-conformidade.test.ts` passou com 18 testes e dados sintéticos. Os casos de triagem simulam a classificação SPDX para isolar a seleção dos pares.
- `git diff --check` passou.

## Limites e pendência

O rastreamento estático segue a ordem textual de declarações e atribuições simples de JS e TS. A análise de ramos, funções e outras formas de declaração, como parâmetros e desestruturação, exige análise adicional. Os avisos de privacidade e de licenças permanecem como indícios para revisão humana.

A homologação da rodada na imagem fica pendente para o gerente.
