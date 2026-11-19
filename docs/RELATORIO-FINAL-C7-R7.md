# C7 R7 — recursos estáticos e recuperação Docker

## Entrega

- O Lighthouse abre páginas externas e aninhadas por um caminho local que preserva a árvore do snapshot. Referências relativas podem alcançar diretórios pais dentro dessa árvore. Referências iniciadas por `/` usam a raiz estática na mesma origem, inclusive quando `staticDir` contém somente recursos. O k6 continua usando o alias HTTP e a query da declaração.
- A saída de `spawn` com `EAGAIN` libera a reserva quando o erro confirma que nenhum processo Docker iniciou. Falhas de gravação da reserva antes do `create` desfazem só aquela entrada, inclusive se `state.json` já tiver recebido o `rename`. O diário também desfaz a publicação inicial quando falha o `fsync` do diretório pai.
- O cancelamento com ID completo no stdout registra esse ID como candidato à reconciliação. A limpeza consulta o ID, confere a identidade e a etiqueta de propriedade antes de remover e verifica a ausência depois. Uma ausência inicial continua pendente. Saída incompleta mantém a busca pelo nome e pela etiqueta. Os registros legados continuam legíveis pelo reconciliador R7.

## Provas

- `npm_config_offline=true npx tsc --noEmit --skipLibCheck`, `git diff --check` e `node --check` nos seis arquivos JavaScript alterados passaram.
- Em Node 24.22.1, `node --test tests/module-desempenho-collector.test.mjs tests/module-desempenho-orchestrator.test.mjs` passou em 41 testes, sem falhas, cancelamentos ou omissões. Foram usados comandos simulados, dados descartáveis e HTTP local.
- As provas distinguiram recursos homônimos nas duas raízes, preservaram a query no k6 e confirmaram a resposta 404 fora do mapeamento. Injetaram falhas antes e depois do `rename`, compararam `EAGAIN` sem processo com erro relatado por um cliente já iniciado e verificaram o cancelamento com ID inteiro e parcial. Os controles também cobriram ID divergente, etiqueta alheia, publicação tardia e substituição do ocupante do nome original.
- A primeira execução do orquestrador expôs uma corrida no teste existente de cancelamento. O teste passou a aguardar a gravação do objeto simulado antes de cancelar a criação, com o stdout ainda vazio.

## Pendências

- A imagem fixada continua sendo a da R6. A correção do coletor entra em uso após reconstrução, fixação de digest e homologação posteriores. A suíte completa, o laboratório, a instalação viva e os logins reais ficaram fora desta ordem. O histórico de medições do host foi preservado.
- Registros que contêm um ID candidato exigem reconciliador R7 ou compatível. Se o armazenamento continuar falhando durante a reversão de uma reserva, a reconciliação depende do estado que o disco ainda conseguir preservar.
