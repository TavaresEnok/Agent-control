# C7 R9 — documentos servidos no recorte estático

## Classificação

- O coletor usa o primeiro `<base href>` da árvore HTML ativa. Uma base só com `target` deixa a escolha de `href` em aberto. URL inválida e esquemas `data:` e `javascript:` conservam o endereço do documento e encerram a escolha. Um `href` vazio resolve para o próprio documento. O conteúdo de `<template>` fica fora da árvore ativa.
- O Lighthouse omite páginas com uma base efetiva fora da origem estática ou com documentos embutidos identificados por `iframe[srcdoc]`, `iframe[src]`, `frame[src]`, `object[data]` ou `embed[src]`. A cobertura registra o motivo por rota como escopo parcial. A regra vale para páginas da raiz estática e para as servidas pelo prefixo do snapshot.
- As verificações de referências relativas no prefixo consideram a base efetiva e, para recursos anteriores à base, também o endereço do documento. O k6 continua medindo a resposta HTTP do alias declarado com a query original.

## Provas e alcance

- `npm_config_offline=true npx tsc --noEmit --skipLibCheck`, `node --check` nos dois arquivos JavaScript alterados e `git diff --check` passaram. Os 11 testes de `node --test tests/module-desempenho-collector.test.mjs` passaram.
- As fixtures usaram HTML e CSS sintéticos, ferramentas simuladas e HTTP em loopback. Páginas e folhas de estilo do snapshot retornaram 200. Um arquivo CSS irmão, fora do snapshot informado ao coletor, retornou 404 na raiz estática e sob o prefixo do snapshot. A lista entregue ao Lighthouse simulado e a cobertura por rota confirmaram as omissões.
- A análise lê atributos do HTML estático. CSS, JavaScript e a renderização dos documentos embutidos estão fora dessa análise. A validação desta rodada se limita ao arquivo de teste alterado e à checagem de tipos. A correção entra na imagem após uma futura reconstrução e fixação do digest.
