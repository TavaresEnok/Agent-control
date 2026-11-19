# C8 — Documentação viva

O coletor usa TypeDoc 0.28.20 para produzir um catálogo de símbolos exportados com seus comentários, parâmetros e referências ao código. O dependency-cruiser 18.8.0 produz o grafo de dependências e o respectivo diagrama. Mermaid 12.3.0 valida os diagramas da documentação e o gerado do código. O parser usa jsdom 31.0.1 com execução de scripts e carregamento de recursos desativados. O TypeScript 5.9.3 é usado na análise estática.

O contexto de build é `deploy/modules/documentacao/`. O Dockerfile confere o SHA-256 do lockfile e instala as dependências pelo npm com integridade dos tarballs e scripts de instalação desativados. O índice pinado de `node:22.23.4-bookworm-slim`, o manifesto Linux AMD64 e a versão de Node declarada na configuração da imagem foram conferidos no registro. [Índice OCI da imagem base](https://registry-1.docker.io/v2/library/node/manifests/sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d), [metadados do jsdom](https://registry.npmjs.org/jsdom/31.0.1).

## Contrato do coletor

O entrypoint lê `/repo`, usa uma cópia temporária em `/tmp` e escreve um único JSON UTF-8 em stdout, com `coverage` e `findings`. O ambiente do processo é reduzido à configuração necessária para a execução. O coletor descarta symlinks e configurações de ferramentas da entrada e remove `typedocOptions`, `typedoc` e scripts dos manifests copiados. TypeDoc recebe um tsconfig gerado e o dependency-cruiser usa regras da imagem.

Falhas de ferramenta aparecem como `failed`, inclusive quando um comando termina com erro depois de gerar um arquivo parcial. O consumidor recebe o JSON para gravar o relatório antes de sinalizar a falha do módulo. A cobertura lista entradas omitidas e medições por arquivo, incluindo reflexões TypeDoc, assinaturas Markdown conferidas, módulos do grafo, arestas documentadas e blocos Mermaid.

O JSON bruto também entrega `api.json` e `dependencias.mmd` nas linhas `typedoc:artefato` e `dependency-cruiser:artefato`. Cada `detail` dessas linhas é um objeto JSON serializado com `artifact`, `part` (começando em 1), `parts` e `content`. Para recuperar o arquivo, agrupe pelo nome, confira a sequência e concatene os valores de `content` na ordem de `part`. Essa representação conserva o contrato do coletor e independe de um volume de saída gravável.

## Prova local com dados sintéticos

O `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` no contexto do módulo passou com Node 22.23.4. O teste direcionado com as ferramentas instaladas teve sete casos aprovados e o caso Docker desativado. A fixture `tests/fixtures/module-documentacao/defective/` produziu estes sete achados, e `control-clean/` produziu zero. Os dois casos geraram o catálogo e o diagrama.

| Local da fixture | Evidência observada |
| --- | --- |
| `src/billing.ts:5` | TypeDoc reporta o parâmetro removido `obsoleteDiscount` |
| `src/billing.ts:12` | TypeDoc mostra a exportação sem documentação `undocumentedCharge` |
| `src/api.ts:7` | TypeDoc reporta o link para `MissingTaxTable` |
| `README.md:7` | A assinatura Markdown tem um parâmetro a mais que a exportação |
| `README.md:15` | O grafo confirma a ausência da aresta documentada para `src/legacy-tax.ts` |
| `README.md:15` | Mermaid registra a referência a `src/legacy-tax.ts` fora da entrada copiada |
| `README.md:22` | Mermaid rejeita a sintaxe da seta com rótulo incompleto |

Comandos da prova local, a partir da raiz do worktree:

```sh
npm --prefix deploy/modules/documentacao ci --omit=dev --ignore-scripts --no-audit --no-fund
C8_TEST_LOCAL_TOOLS=1 env -u AC_MODULE_LAB node --import tsx --test tests/module-documentacao.test.ts
npx tsc --ignoreConfig --noEmit --skipLibCheck --strict --target ES2022 --module NodeNext --types node tests/module-documentacao.test.ts
```

A checagem TypeScript do arquivo C8 passou. O comando pedido, `npx tsc --noEmit --skipLibCheck`, saiu com código 1 no worktree por dependências compiladas ausentes em `upstream/cezar/packages/cezar/dist/` e diagnósticos nos consumidores do Cezar. A execução final ficou sem diagnósticos nos arquivos C8.

## Build e laboratório para a integração

A etapa de integração gera o ID imutável da imagem e roda o laboratório pelo ID. O teste monta apenas as duas fixtures sintéticas em `/repo` como somente leitura, com UID/GID 65532, rede desligada, raiz somente leitura, capabilities removidas e `/tmp` em tmpfs. Ele verifica o contrato do stdout, os achados, os artefatos e o controle limpo.

```sh
docker build --platform linux/amd64 -t ac-module-documentacao:c8 deploy/modules/documentacao/
docker image inspect --format '{{.Id}}' ac-module-documentacao:c8 > deploy/modules/documentacao/digest.txt
AC_MODULE_LAB=1 node --import tsx --test tests/module-documentacao.test.ts
```

O build, o ID final e o resultado do laboratório estão pendentes dessa integração.

## Limites da coleta

- A cópia comporta até 10.000 arquivos, 2 MiB por arquivo e 192 MiB no total. Diretórios ocultos e de dependências ou build ficam fora, assim como configurações de ferramentas. Cada artefato transportado tem limite de 512 Ki caracteres, com omissão explícita na cobertura.
- A análise usa JavaScript e TypeScript com configuração gerada e sem dependências do projeto instaladas. Aliases e resolução específica do projeto podem reduzir a cobertura. A checagem de assinaturas Markdown cobre funções identificáveis por nome e argumentos simples em código inline.
- Mermaid valida sintaxe e cruza rótulos de caminho e arestas de módulo reconhecíveis em fluxogramas. Para caminhos, a referência é a cópia que o coletor conseguiu analisar. Diagramas operacionais têm validação de sintaxe. A revisão humana ou independente continua responsável pelas afirmações em prosa e pelo significado dos diagramas.
