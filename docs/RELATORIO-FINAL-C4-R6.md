# Módulo 4 de dependências · rodada R6

Ordem `ORDEM-FINAL-C4-R6.md`, a partir de `ea172fa4` no worktree `task/final-c4`. A rodada tratou os achados da revisão de `8669f900`.

| Área | Correção e prova sintética |
| --- | --- |
| Atualizações npm | Uma proposta com lock npm exige que a versão do inventário satisfaça a faixa alvo e supere a versão travada. O menor piso das alternativas do alvo precisa ser pelo menos a versão travada. O teste cobre inventário inferior, versão igual, faixa com alternativa inferior apesar de inventário mais novo e avanços de patch, minor e pré-lançamento. A severidade usa as versões concretas quando o lock é verificável. |
| Cobertura por dependência | Tags e alvos incomparáveis têm omissão por manifesto, seção e pacote. O coletor preserva propostas válidas na mesma resposta e registra como falha os itens com tipo incorreto ou pacote desconhecido. As propostas omitidas conservam a análise de lock. |
| Resolução npm e aliases | A mesma resolução de workspace atende à análise de lock e ao npm-check-updates. O binário 23.1.1 comprovou a precedência do `npm-shrinkwrap.json` da raiz e a entrada de instalação efetiva. Para aliases, o teste comprovou a identidade moderna pelo campo `name` e a legada pela versão `npm:`. Ausência de lock, ausência de identidade e identidade divergente geraram omissão. |
| ast-grep | O binário 0.51.3 comprovou um diagnóstico de várias linhas com CRLF, acentos e emoji antes da ocorrência. O coletor confere o texto e os dois limites do intervalo por bytes, linha e coluna em pontos de código. A saída simulada rejeitou texto divergente, posição dentro de um caractere e coordenadas inconsistentes sem retirar o achado de outro arquivo. |
| CycloneDX | O validador local aplicou o esquema JSON oficial da versão declarada de 1.2 a 1.7. Os controles rejeitaram versão desconhecida, campo obrigatório ausente, tipo de componente de outra versão, licença fora da lista SPDX, data inválida e objetos repetidos com chaves em outra ordem. Um BOM inválido pelo esquema falha antes de produzir achados. Outros inventários continuam sendo medidos. O teste de volume preservou o limite de 20 mil componentes. |
| jscodeshift | O jscodeshift 17.4.0 executou o transformador do módulo com o parser TypeScript em `.mts` e `.cts`. Nos dois arquivos com padrões legados, os achados pediram revisão e as cópias permaneceram idênticas byte a byte. No controle limpo, o binário retornou zero erros e um arquivo pulado pelo transformador, com um único registro NDJSON de caminho, nonce e SHA-256 e zero achados. |

Os esquemas e suas três referências estão fixados na versão 1.7 da distribuição oficial, no commit `4b3f59453366e27c8073fd24e98bf21ef8892c8e`, com a licença Apache 2.0. A validação usa somente os arquivos locais empacotados no módulo. [CycloneDX 1.7](https://github.com/CycloneDX/specification/releases/tag/1.7)

## Verificação

- Node 22.23.4 com npm offline. `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-dependencias.test.ts` passou com 27 testes.
- `npm ci --offline --omit=dev --ignore-scripts` instalou as dependências do módulo em um diretório temporário limpo e passou no verificador de integridade.
- `node --check` passou no coletor, no validador CycloneDX e no transformador. O verificador de integridade confirmou 132 pacotes no lock e nove dependências fixadas. `git diff --check` passou.

## Pendências e limites

A prova usou ferramentas locais e fixtures sintéticas. A integração da nova definição da imagem, a suíte completa, o laboratório e a verificação na instalação viva ficam para a rodada de integração. Comparações com lock exigem versão concreta disponível no inventário, inclusive quando o npm-check-updates está em modo online. A resolução de versões instaladas cobre os formatos de lock do npm.
