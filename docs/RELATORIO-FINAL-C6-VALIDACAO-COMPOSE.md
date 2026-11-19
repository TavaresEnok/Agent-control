# Validação sintática de Compose na prontidão

O coletor valida o documento Compose inteiro com `yaml` 2.9.1 antes de extrair dados dos serviços. Uma coleção aninhada incompleta ou uma tag YAML sem fechamento em `x-notes`, antes ou depois de `services`, deixa a cobertura parcial e impede uma conclusão sobre o reinício. A cobertura usa uma mensagem genérica, sem reproduzir o conteúdo do arquivo nem o diagnóstico bruto do parser.

A validação usa `parseDocument` com o esquema `failsafe`, sem conversão para objetos JavaScript, expansão de aliases, interpolação de variáveis ou acesso à rede. Tags sintaticamente válidas em extensões continuam aceitas. O extrator existente mantém as linhas das evidências e a interpretação das chaves suportadas. Referências em serviços continuam com cobertura parcial, e o limite de 1 MiB por arquivo continua aplicado antes da leitura estática.

A versão e a integridade do pacote estão fixadas no lock de prontidão, com a mesma versão usada em arquitetura. O Dockerfile instala a dependência na etapa de ferramentas e a inclui na imagem final. Para execução local em um checkout novo, instale a dependência com `npm ci --prefix deploy/modules/prontidao --ignore-scripts --no-audit --no-fund`.

## Verificação local

- O teste de regressão falhou na base `f485490c`. Com a correção, as variantes inválidas ficaram com cobertura parcial e os controles válidos mantiveram a linha de evidência esperada.
- A instalação pelo lock passou com `npm ci --prefix deploy/modules/prontidao --offline --omit=dev --ignore-scripts --no-audit --no-fund`.
- `npx tsc --noEmit --skipLibCheck` passou em modo offline.
- `node --import tsx --test tests/module-prontidao.test.ts` passou com 36 testes e subtestes e fixtures sintéticas.
- `node --check deploy/modules/prontidao/audit-readiness.mjs` e `git diff --check` passaram.

A validação da imagem ficou pendente. A alteração preexistente em `deploy/modules/prontidao/digest.txt` foi preservada fora do commit.
