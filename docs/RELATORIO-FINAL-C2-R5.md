# C2 R5 — Coleta e execução funcional de QA

Revisão da ordem C2 R5 sobre os nove achados do parecer de `606e7061`. A base do worktree é `ed62d721`.

## Correções e controles

| Item | Resultado e prova |
| --- | --- |
| Propriedades de validadores | A linha `qa-fuzz` fica em `skipped`. Quatro casos declarados mediram o validador de quantidade em três passadas reais de `node:test`. O controle limpo passou nos quatro. Trocar a rejeição por retorno, preservando a regex e as verificações numéricas, reprovou os dois casos de rejeição. Sem execução ou com skip, a linha de propriedades fica em `skipped` quando nenhum caso foi medido. |
| Referência e mutantes | Ambos usam o mesmo runner V8, preload, permissões, diretório temporário de cobertura e limites, em cópias novas. A classificação exige referência elegível sem patch. O controle que depende do preload passou na referência e no mutante equivalente. Alterar a fronteira de 100 reprovou somente a asserção funcional esperada. |
| Caminhos e JSON | A coleta recusa o segmento `..` e aceita `..` como parte do nome. O teste verificou uma única linha JSON com `versao..md`, nome com espaço e acento e achado em `clean/tests/segundo..test.ts`. |
| Recorte da cópia | Cada motivo de exclusão aparece na cobertura com sua contagem. A árvore `clean/` de um projeto é coletada normalmente, inclusive se contiver um subprojeto. A fixture limpa tornou-se irmã da fixture com defeitos. Controles atingiram 400 arquivos, 1 MiB por arquivo, 64 MiB totais e o limite de profundidade. As análises estáticas identificaram o escopo parcial e a matriz e o contrato deixaram a ausência de prova em aberto. |
| Opções de testes | A auditoria estática usa a AST do `@babel/parser` instalado. Um callback com asserção após `{timeout: 1000, skip: false}` foi vinculado ao requisito e aprovado nas três passadas. |
| Skip e todo | Os controles cobrem opção, suíte pulada e chamada pelo contexto do teste. Um candidato que o runner marcou como pulado ou pendente perdeu o valor de prova na matriz. |
| Rotas parametrizadas | `GET /pedidos/:id` e `GET /pedidos/{pedido}` foram vinculados. Os controles conservaram diferenças de método, prefixo e sufixo. Uma rota opcional ficou com comparação em `skipped`. |
| Acessibilidade | A cobertura identifica HTML estático em jsdom, a ausência de scripts e layout, a regra `color-contrast` desativada e resultados inconclusivos. O HTML sintético de baixo contraste confirma que essa regra ficou fora da medição. |
| Ferramentas e versões | As versões de bibliotecas executadas vêm dos pacotes carregados. A auditoria é identificada como estática. As linhas de fuzz e carga ficam em `skipped` com versão `não aferida`. |

A declaração `QA-VALIDADOR: ` identifica um caso de borda sintético de um validador declarado puro pelo autor. A forma reconhecida é um `node:test` no nível do módulo, com asserção direta de igualdade ou rejeição sobre uma função exportada importada de arquivo local e chamada com literais. A cobertura computa somente casos vinculados a um resultado de aprovação ou reprovação nas três passadas. Os testes seguem o executor `node:test` já previsto pelo módulo.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-qa.test.ts` passou com 20 testes, sem falhas ou skips. As passadas dinâmicas usaram subprocessos do runner V8 sobre fixtures sintéticas temporárias.
- A prova de publicação foi habilitada com `QA_SYNTHETIC_PROOF` apontando para o JSON sintético fornecido e `QA_MODULE_RUNTIME` para cópia temporária dos arquivos comuns de `a0ecf995`. O parser comum aceitou a saída R5 e `writeModuleReport` publicou o JSON bruto em diretório temporário. O controle de segredo sintético continuou sendo recusado.
- `node --check` nos três módulos JavaScript, `sh -n` no entrypoint e `git diff --check` passaram.

## Pendências

A execução pelo digest, incluindo as asserções atualizadas em `tests/module-qa-lab.test.ts`, fica para a integração autorizada. O digest e os arquivos da imagem foram preservados. A validação usou testes direcionados e dados sintéticos no worktree, sem laboratório, suíte completa, instalação viva ou login real.

A prova de nomes com espaço e acento cobre o JSON do coletor. Na base comum usada para a prova de publicação, o parser aceita um conjunto ASCII mais restrito para caminhos de achados. Essa restrição pertence à integração.
