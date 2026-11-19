# Módulo 4 de dependências · rodada R7

Ordem `ORDEM-FINAL-C4-R7.md`, executada no worktree `task/final-c4` a partir de `8da07644`.

| Área | Correção e prova sintética |
| --- | --- |
| Versão instalada | O NCU exige uma entrada efetiva do lock npm para dependências comuns e aliases. A versão precisa satisfazer a declaração. A identidade vem da entrada de instalação e, nos aliases, do nome npm registrado no lock. Os controles cobrem lock ausente, entrada ausente, versão incompatível e identidade divergente. |
| Avanço e risco | O alvo confirmado precisa superar a versão travada. O teste mantém as omissões de downgrade, versão igual e faixa que admite versão inferior à travada. Os achados usam as versões concretas no cálculo da severidade e mostram a entrada do lock na evidência. As fixtures de confirmação positiva alteradas incluem versões instaladas que satisfazem a declaração. |
| Catálogo offline | O NCU usa um catálogo JSON local válido. Ausência ou invalidez do catálogo gera cobertura `skipped`. O catálogo entregue à ferramenta contém apenas versões SemVer válidas. Falha do processo, JSON inválido da ferramenta e propostas com tipos inválidos ou nomes desconhecidos geram `failed`. |
| Origem online explícita | O NCU usa `https://registry.npmjs.org/` com `--removeRange`. O coletor consulta a publicação exata nesse registro e confere o nome npm e a versão retornados. O teste confirma pacote comum e alias escopado com catálogo local ausente ou desatualizado. HTTP 404 e identidade divergente geram omissão. HTTP 503 gera falha e preserva as propostas comprovadas. O teste simula o processo e o transporte HTTPS. Uma execução separada do NCU 23.1.1 com catálogo local comprova que `--removeRange` preserva a identidade do alias e devolve uma versão exata. |
| UTF-8 | O lock npm é validado antes da decodificação JSON. O controle tem bytes inválidos em um campo que permitiria o parse após substituição silenciosa. O ast-grep diagnostica bytes inválidos por arquivo mesmo sem rastreio, inclusive quando o processo termina com erro. |
| CycloneDX | Os esquemas publicados de 1.2 a 1.7, suas referências e o validador permaneceram intactos. Os testes existentes de estruturas, versões, referências e limites passaram. |

O modo padrão permanece offline. No modo online, referências Git ficam como declarações não comparáveis, pois a confirmação cobre publicações do registro npm.

## Verificação

- Node 22.23.4. `npx tsc --noEmit --skipLibCheck` passou com npm em modo offline.
- `node --import tsx --test tests/module-dependencias.test.ts` passou com 29 testes sintéticos.
- `node --check` passou nos dois módulos JavaScript alterados, e `git diff --check` passou.

## Pendências e limites

A fixture interna `lab-mixed-metadata` em `tests/module-dependencias-lab.test.ts` precisa de um lock compatível para continuar esperando um achado do NCU sobre o Express quando a correção chegar ao laboratório. A integração da imagem, o ajuste dessa fixture e a prova de laboratório ficam pendentes. A rodada se limitou ao worktree e aos testes focados com dados sintéticos.
