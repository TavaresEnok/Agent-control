# C9 — atribuição e escopo, revisão R2

As cinco provas existentes foram preservadas. O contrato das três fixtures confere a lista exata das linhas `lgpd-static:file` e a ausência da propriedade `files`, como emitida pelo coletor. Nas duas fixtures com manifesto, o agregado estático deve conter exatamente `src/telemetry.ts` e `vendor/widget.js`; os mocks rejeitam ausência, troca e arquivo inexistente. As expectativas são literais independentes dos valores do relatório e dos mocks.

O grupo de evidências locais da fixture de atribuição exige um achado `lgpd-static` em cada um de `operations.js` e `operations.py`. Os controles removem individualmente cada achado ou trocam sua ferramenta. A mesma verificação é aplicada à saída real quando o laboratório for executado. Os controles existentes para grupos, códigos, estados e vazamento permanecem.

Para `com-defeito`, a lista completa de destinos `PII_POSSIBLE_*` deve ser exatamente `PII_POSSIBLE_LOG` em `src/telemetry.ts:3`; para `limpo`, deve ser vazia. O mock rejeita uma atribuição adicional na linha 1. As expectativas são fixadas a partir das fixtures, não do relatório produzido.

Verificações neste worktree:

- `npx tsc --noEmit --skipLibCheck`: passou.
- `env -u AC_MODULE_LAB -u AC_MODULE_LAB_MODULE node --import tsx --test tests/module-conformidade-lab.test.ts`: dois testes sintéticos passaram e três testes de laboratório foram pulados.
- `git diff --check`: passou.

A imagem fixada não foi executada, conforme a restrição desta ordem. Assim, a compatibilidade das novas expectativas com a imagem ainda depende da prova física pelo responsável autorizado. Não houve alteração do produto, reconstrução de imagem ou acesso à instalação viva.
