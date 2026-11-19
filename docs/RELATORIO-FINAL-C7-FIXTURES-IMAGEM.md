# C7 — PNG da fixture e rotas estáticas

A fixture sintética de `tests/module-desempenho-collector.test.mjs` usa um PNG de 1 × 1 pixel com o CRC do bloco `IDAT` corrigido de `ef9a3ebb` para `efa2a75b`. Na validação local, conferi a assinatura, as dimensões, os CRCs dos três blocos e a descompressão dos dados de imagem.

O Lighthouse simulado verifica por HTTP local que o PNG retorna `200`, tem tipo `image/png` e contém exatamente os bytes da fixture. A origem canônica cobre as URLs com e sem consulta, e a origem montada cobre o PNG sob o prefixo do snapshot. O controle com `avulso.css` exige `404` na raiz das duas origens e também sob o prefixo da montagem. O teste confere ainda a seleção das duas páginas com PNG e os registros de escopo parcial para imagem ausente, HTML declarado como imagem e SVG.

## Verificação

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --test tests/module-desempenho-collector.test.mjs` passou nos 12 testes com fixtures sintéticas.
- `node --check tests/module-desempenho-collector.test.mjs` e `git diff --check` passaram.
