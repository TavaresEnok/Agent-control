# C7 R10 — imagens embutidas no escopo estático do Lighthouse

O classificador mantém páginas com `object[data]` ou `embed[src]` quando o servidor estático da própria página confirma, via `HEAD`, uma resposta bem-sucedida com `Content-Type` de PNG, JPEG ou WebP. Quando há um `type` declarado, ele precisa corresponder ao tipo servido. A consulta usa a URL resolvida pela base HTML, fica na origem local da página e desabilita redirecionamentos. Para elementos anteriores à base, a classificação também considera a URL do documento.

Documentos embutidos e conteúdo indeterminado continuam registrando escopo parcial na cobertura. SVG embutido permanece nessa regra porque pode abrir um documento XML. O classificador usa os metadados HTTP e a validação desta rodada simulou o Lighthouse, sem executar o navegador. [Algoritmo do elemento `object` no padrão HTML](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#the-object-element)

## Verificação

- A fixture do coletor confirmou as duas páginas com PNG na seleção do Lighthouse simulado. Na origem canônica e na origem com a montagem do snapshot, a página e a imagem responderam `200`, a imagem veio com `image/png` e `/avulso.css` respondeu `404`. As páginas com uma imagem ausente, HTML declarado como imagem e SVG permaneceram com cobertura parcial.
- `npx tsc --noEmit --skipLibCheck`, `node --check` nos dois arquivos JavaScript alterados e `git diff --check` passaram. Os 12 testes de `node --test tests/module-desempenho-collector.test.mjs` passaram com fixtures sintéticas e HTTP em loopback.
