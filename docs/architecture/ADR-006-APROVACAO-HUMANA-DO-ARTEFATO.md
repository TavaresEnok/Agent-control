# ADR-006 — Aprovação humana do artefato pelo cockpit

Estado: implementado parcialmente e verificado na bancada.

O comando assinado `integration.approve` exige proprietário do projeto e vincula a decisão ao contexto, artefato, digest, revisão de política e destino congelado. Uma alteração de digest ou tentativa de escolher outro destino é recusada. O antigo helper interno sem assinatura foi retirado; a mesma gravação de aprovação foi reaproveitada dentro da transação de Control, junto à deduplicação e auditoria.

A aprovação **não** substitui QA/revisão/julgador, não abre admissão, não retoma pausa e não autoriza publicação/deploy. O integrador continua conferindo o artefato real e usando CAS na base aprovada.

A etapa de integração aguarda aprovação na mesma operação registrada, antes de qualquer efeito Git. Não classifica ausência de aprovação como falha de verificação. Cancelamento ou autoridade inválida continuam recusados; a espera não reinicia implementação.

O painel consulta somente artefatos da conversa, identifica commit/árvore/base/política/destino e exige carregar uma prévia correspondente antes de habilitar a ação. A API usa AcSafeGit/AcArtifactIdentity existentes, sem hooks, textconv ou diff externo. A prévia é limitada a 20.000 bytes; quando truncada, o botão permanece bloqueado. O produto ainda precisa de um fluxo homologado de revisão integral de diffs maiores, sem ampliar silenciosamente o limite nem supor que o hash basta para revisão humana.

## Evidências

`integration-approval-native-20261102.log`: três casos nativos passaram. O caso de aprovação humana conclui QA/revisão, aguarda com a branch protegida intacta, lê o diff do artefato pela API, recusa digest/destino divergentes, deduplica a assinatura e integra exatamente o commit aprovado uma vez. Nenhum modelo real foi chamado.

`integration-approval-ui-20261102.log`: types web e dois casos de componente passaram, incluindo bloqueio antes de carregar e com prévia truncada. `integration-approval-root-build-20261102.log`: backend compilou.

Login/pareamento completo, revisão humana independente real, dispositivo físico, crash durante a espera/merge e diffs maiores continuam sem homologação. Os testes sintéticos não concedem aprovação de produção.
