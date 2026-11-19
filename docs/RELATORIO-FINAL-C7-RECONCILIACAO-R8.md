# C7 R8 — reconciliação Docker e rotas estáticas

## Correções

- O diário grava uma reserva que bloqueia a busca por nome antes de enviar `docker create` ou consultar um nome de um registro anterior. Em uma criação incerta, a busca por nome fica disponível quando o cliente termina com saída vazia ou um prefixo hexadecimal incompleto. Uma resposta com ID completo fixa a identidade, inclusive se o cliente for cancelado. A remoção exige inspeção pelo ID, com confirmação da etiqueta de propriedade.
- Em uma nova passagem, o reconciliador valida `state.next` e conclui sua publicação sem regravar o arquivo. Uma nova falha de `fsync` durante essa tentativa preserva o conteúdo pendente. Se os dados disponíveis forem insuficientes para recuperar o ID, a reserva fica pendente sem consultar o nome.
- Em páginas servidas pelo prefixo do snapshot, o coletor usa `parse5` para ler referências declaradas no HTML, incluindo `<base>` e `srcset`. Se uma referência relativa subir além da raiz do snapshot, a rota recebe uma omissão explícita na cobertura do Lighthouse. A medição k6 usa o alias declarado e a query original. Referências na árvore do snapshot e URLs iniciadas por `/` continuam usando as raízes previstas pelo recorte.

## Verificações

- `npm_config_offline=true npx tsc --noEmit --skipLibCheck` e `git diff --check` passaram.
- `node --test --test-concurrency=1 tests/module-desempenho-collector.test.mjs tests/module-desempenho-orchestrator.test.mjs` passou em 44 testes. A primeira execução, com os arquivos em paralelo, falhou na asserção de ordenação do teste de orçamento de dois segundos do backend. A execução em série passou com o mesmo prazo.
- A fixture Docker distinguiu por ID o objeto original renomeado e o substituto homônimo com a mesma etiqueta. Simulou escrita truncada, falhas consecutivas de `fsync` e cancelamento depois que uma inspeção por nome retornou o ID. Quando havia um ID recuperável, um segundo processo removeu apenas o objeto original. Com o diário truncado, a execução ficou pendente e os dois objetos sintéticos foram preservados.
- A fixture HTTP verificou as referências relativas dentro da árvore e os recursos absolutos na raiz estática. Páginas com referências acima da raiz, inclusive em um atributo com pontos codificados, em `srcset` com `<base>` e em uma URL relativa com esquema `http:`, ficaram fora da coleta do Lighthouse. O k6 sintético confirmou as respostas dos aliases dessas páginas.

## Alcance

- A verificação estática cobre referências declaradas nos atributos HTML examinados. Referências geradas em JavaScript ou resolvidas dentro de folhas de estilo estão fora dessa verificação.
- As provas usaram arquivos temporários, executáveis sintéticos e HTTP em loopback. A correção do coletor depende de uma futura reconstrução e fixação do digest da imagem para entrar em uso. A validação desta ordem se limita aos dois arquivos de teste e ao TypeScript.
