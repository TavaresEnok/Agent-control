# C9 — conciliação de escopo e ferramenta, revisão R3

Nas duas fixtures com manifesto, a prova exige uma linha `lgpd-static:file` por arquivo, com estado fixado conforme a fixture: os dois arquivos JSON são `skipped`, e `src/telemetry.ts` e `vendor/widget.js` são `ok`. O agregado integral continua exigindo exatamente os dois arquivos AST. A matriz é literal e independente do relatório recebido; ausência, duplicação, troca de nome ou de estado são rejeitadas. Permanece a proibição de `files` nas linhas individuais.

A lista de destinos em `com-defeito` compara ferramenta, regra, caminho e linha, incluindo cardinalidade; `limpo` continua sem destinos. A prova física de atribuição também exige a ferramenta `lgpd-static` para cada destino, além das comparações anteriores de arquivo, regra, linha e origem. Os controles de proteção e as demais verificações foram mantidos.

Os controles sintéticos alteram somente o estado da linha de telemetry, mantendo o agregado, e somente a ferramenta do destino plantado; ambas as alterações são rejeitadas. Também há controles para falta, duplicata e troca das linhas e duplicação do destino.

Verificações neste worktree:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `env -u AC_MODULE_LAB -u AC_MODULE_LAB_MODULE node --import tsx --test tests/module-conformidade-lab.test.ts`: dois testes sintéticos passaram; três testes físicos foram pulados.
- `git diff --check`: passou.

O laboratório físico com todas as fixtures permanece para o gerente autorizado. Não foram alterados arquivos de produto, reconstruídas imagens ou acessadas instalações vivas.
