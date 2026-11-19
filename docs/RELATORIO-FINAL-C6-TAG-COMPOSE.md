# Validação de tag explícita no Compose

O `yaml` 2.9.1 aceita a tag verbatim vazia `!<>` sem preencher `document.errors`. A validação do documento inteiro agora consulta os tokens de sintaxe do parser quando encontra essa sequência no arquivo. Um token do tipo `tag` com conteúdo exatamente `!<>` aciona a cobertura parcial existente e deixa indeterminadas as verificações de logs, reinício automático, limites de recursos e segredos no Compose. O relatório do coletor registra a falha genérica de estrutura YAML e omite o conteúdo do token.

O teste de documento completo cobre tags vazias em valor de mapa, item de sequência em fluxo e chave explícita, em extensões de raiz antes e depois de `services`. Os controles mantêm a cobertura e a linha do achado de reinício para extensões com tags válidas, comentários e texto literal em escalares com aspas, simples e de bloco.

## Verificação local

- O teste de documento completo falhou na base `7233fe29` porque a tag vazia ainda recebia cobertura de sucesso. Passou após a correção.
- `npx tsc --noEmit --skipLibCheck` passou com o npm em modo offline.
- `node --import tsx --test tests/module-prontidao.test.ts` passou com 36 testes e subtestes usando fixtures sintéticas.
- `node --check deploy/modules/prontidao/audit-readiness.mjs` e `git diff --check` passaram.

A verificação se limitou ao arquivo de testes alterado e às checagens estáticas. A instalação viva e a imagem ficaram fora da verificação. A alteração preexistente no digest de prontidão ficou fora do commit.
