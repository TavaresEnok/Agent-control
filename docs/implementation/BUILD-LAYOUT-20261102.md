# Correção de distribuição — emissão TypeScript e links de runtime

## Defeito observado

O pós-build antigo criava `dist/upstream -> ../upstream`. Após adicionar imports dos contratos TypeScript compartilhados, um build subsequente emitiu quatro arquivos JavaScript pelo symlink, dentro de `upstream/cezar/packages/contract/src`. Eram `agent-control-plans.js`, `health.js`, `secrets.js` e `workflows.js`; não eram fontes rastreadas. Não bastava excluir esses arquivos: o build seguinte repetiria a colisão.

## Correção

- `package.json` executa `prepare-build.mjs --before` pelo lifecycle `prebuild`, antes de `tsc`.
- A preparação usa `lstat` sem seguir links e remove somente links cujo destino resolve exatamente para o caminho fonte correspondente. Diretórios e arquivos reais emitidos são preservados. Link inesperado ou raiz/ancestral de saída simbólico provoca recusa.
- O pós-build mantém `dist/upstream` físico e o contrato compilado no seu próprio diretório. Acrescenta somente os recursos necessários: leaf links do runtime Cezar e Happier e assets `db`, `scripts`, `services`.
- Se um subtree já contiver emissão física, o overlay preserva os arquivos emitidos e liga apenas recursos ausentes; não substitui um diretório físico por um symlink abrangente. Não reescreve exports dos pacotes upstream.
- O entrypoint suportado continua `npm run build`; executar `tsc` manualmente contorna seus hooks. Esta correção não declara o dist um bundle autossuficiente: os runtimes/dependências upstream continuam necessários, como antes.

## Comprovação e limpeza delimitada

Um `npm run build` na bancada Node 22 passou, seguido de importação de `dist/src/api.js` e `dist/src/planning-api.js`, sem abrir servidor, banco ou agentes. `build-layout-final-20261102.log` registra os hooks e os dois marcadores de importação.

Antes de apagar qualquer arquivo da origem, os quatro nomes exatos foram conferidos como não rastreados, regulares, com fonte `.ts` existente, e SHA-256 **idêntico à emissão fresca em dist físico**. Só após todas as comparações positivas foram removidos. `build-layout-source-cleanup-20261102.json` registra hashes dos quatro outputs e das fontes preservadas. Nova importação da API compilada passou depois da limpeza, confirmando que ela não dependia dos JS acidentais na origem.

A revisão por leitura do agente de provedores não encontrou erro alto concreto no novo layout; não repetiu o build. Nenhuma instalação operacional, credencial, fila ou serviço foi alterado. Não houve migração ou publicação.
