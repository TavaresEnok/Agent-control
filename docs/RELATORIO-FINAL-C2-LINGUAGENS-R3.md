# C2 — escopo e atribuição de testes Python e Go

O worktree partiu de `a386516b`. O merge `d1ebf722` incorporou `3757031b`, a base do adaptador examinada no parecer R2, e preservou o histórico das medições de mutação.

| Caso do parecer | Resultado e prova |
| --- | --- |
| Omissão de insumo rastreado | Uma entrada protegida encerra a seleção com escopo parcial antes da materialização. A fixture cobre `tests/fixtures/auth.json`, `testdata/build/quantity.txt`, `.env.test`, um arquivo de chave e um diretório de credenciais, todos com conteúdo sintético. Um controle copia dados regulares novos a cada passada. A seleção dentro do contêiner usa a árvore montada, inclusive quando o inventário estático preliminar omite dados de teste. |
| `pytest` indisponível na descoberta | Um `unittest.TestCase` que importa `pytest.raises` foi registrado como dependência indisponível. A classificação de formato pytest usa módulos importados com sucesso. Uma importação quebrada dentro de pacote local e uma reprovação dentro de um caso exercitam os estados de erro e falha funcional. |
| Go sem atribuição de arquivo | O resumo inclui casos sem localização. As linhas por pacote registram as reprovações por passada e indicam as passadas parciais. As fixtures com dois arquivos candidatos cobrem reprovação estável, oscilação, reprovação em uma passada parcial e atribuição que varia entre passadas. A variação de atribuição preserva a contagem de um único caso. Um teste Go real confirmou a preservação do evento reprovado com `file: null` quando falta a localização. |
| Go incompatível no host | A fixture sonda a versão exata do binário. Com Go 1.27.4, ela mediu cobertura, leu um arquivo de `embed`, atribuiu subtestes e verificou o teto de 200 entradas. Com Go 1.22.2, a sondagem recusou a versão e a prova do overlay registrou o salto esperado. |
| Interrupção do pytest | A preservação de propriedades concluídas em `a386516b` cobria a saída 1. Um `KeyboardInterrupt` sintético após uma falsificação real do Hypothesis encerrou o pytest com código 2 e preservou a propriedade já medida. A prova do publicador confirmou a contagem de chamadas concluídas, o achado da falsificação e a linha de falha operacional. |
| Isolamento de `unittest` | O runner mantém as raízes do projeto e o caminho da cobertura. A fixture reproduziu a estrutura com as dependências de mutação ao lado do runner e confirmou que um caso com Hypothesis opcional pulou enquanto o controle passou. |
| Erro operacional de compilação Go | A medição separa o diagnóstico de fonte de uma falha operacional de compilação. O mutante real com divisão inválida ficou sem medição por reprovação de compilação. Erros sintéticos de criação do processo, tanto em `stderr` quanto em eventos de compilação, geraram linha operacional com status `failed`. Uma falha de compilação sem diagnóstico de fonte também é operacional. |
| Evento Go aprovado | `a386516b` já ignorava o texto de saída comum ao classificar o resultado. A prova sintética e a prova Go real confirmaram a aprovação apesar de um log iniciado com `panic:`. |

## Verificações

- `npx tsc --noEmit --skipLibCheck`, `node --check`, análise sintática do runner Python e `git diff --check`.
- 25 testes passaram, sem saltos, nos arquivos `tests/module-qa-linguagens-r2.test.ts`, `tests/module-qa-mutacao-linguagens.test.ts` e `tests/module-qa-mutacao-integracao.test.ts`. As fixtures usaram Node 24.22.1, CPython 3.12.3, coverage.py 7.13.5, pytest 8.4.2, Hypothesis 6.140.2, mutmut 3.5.0 e Go 1.27.4.
- A rodada restrita à sondagem e ao overlay com Go 1.22.2 registrou um teste aprovado e um salto esperado.

## Limites e pendências

- Uma entrada protegida pode ser uma fixture legítima. Nessa situação, o adaptador registra escopo parcial e pula a execução para evitar resultados sobre uma árvore incompleta. A proteção usa nomes e formatos reservados.
- As verificações usaram fixtures locais. A execução no contêiner empacotado e os limites físicos do ambiente ficaram fora da rodada.
