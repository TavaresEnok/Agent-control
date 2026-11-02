# Fronteira de coletores de provedores — 02/11/2026

Implementação em `src/providers.ts` e migração `033_provider_observations.sql`.

`ProviderCollectors` recebe um registro de adaptadores confiáveis na composição do processo; clientes não enviam comandos, URL, paths de credenciais ou stdout. O vínculo por conta é versionado e comparado com digest/versão do manifesto. A habilitação exige conta sintética, provedor correspondente e elegibilidade documentada; nenhuma conta real foi cadastrada ou inferência ativada.

A coleta usa lease e intervalo mínimo globais no PostgreSQL por conta. Consultas simultâneas não multiplicam probes. Resposta de lease antiga/expirada não grava cota. Timeout solicita abort, mas não prova parada: vínculo fica em quarentena e novos probes são recusados. Um processo que caiu com lease expirada também exige reconciliação confiável antes de outro probe; não há repetição cega. A mesma identidade de observação reproduz seu resultado sem chamar o adaptador ou renovar seu TTL. Trocar adaptador invalida a disponibilidade anterior. A versão do adaptador alterada sem novo vínculo é recusada.

Resultados normalizados atualizam `Capacity.observeQuota` na mesma transação PG. Disponibilidade continua subordinada às reservas/seleções existentes, sem scheduler ou semaphore novo. Expiração não vira disponibilidade. Percentual só aparece se o coletor o informou, com origem e prazo; contadores de tokens de `Usage` permanecem separados do saldo da assinatura.

Erros de transporte/timeout são `unreachable`, resposta fora do contrato é `configuration_error`; não são falsamente classificados como cota esgotada. Erro original, stdout, tokens e credenciais não são persistidos. Não há heurística baseada em mensagem livre do provedor.

## Validação delimitada

- `provider-collectors-types-first-20261102.log`: falha de tipagem no teste ao acessar um campo ausente no retorno sem observação; corrigido para forma estável com `null`.
- `provider-collectors-types-final-20261102.log`: typecheck root passou.
- `provider-collectors-first-20261102.log`: primeira prova integrada única passou com PG real, banco descartável e adaptador sintético. Verifica concorrência de probe, deduplicação/TTL, throttle, alimentação de grant real de Capacity, recusa de resposta com propriedade secreta adicional, isolamento por proprietário, versão alterada e saldo expirado desconhecido.

- `provider-control-types-20261102.log` e `provider-control-final-20261102.log`: tipos e prova final passaram após integração com controle assinado. A mesma prova acrescenta vínculo assinado/deduplicado, projeção administrativa, recusa de grant após resposta inválida e quarentena depois de timeout.

## Limites e integração

Nenhum adaptador real Grok/Codex/Claude/Gemini foi homologado. O registro é injetado na composição confiável de `Control(ledger, providerAdapters)`. A ação `provider.bind` usa assinatura humana, CAS de revisão e mesma transação de deduplicação do controle existente; a projeção `view` inclui adaptadores permitidos, vínculos e observações normalizadas/frescas. Nenhum endereço/command arbitrário é aceito. A coleta externa não roda dentro da transação HTTP; `scripts/collect-provider-fixture.mjs` fornece entrada explícita de laboratório com configuração privada, modo sintético e banco de bancada obrigatórios. Não há ativação automática. O bootstrap de produto pode injetar somente coletores previamente homologados. Ainda não existe reconciliador confiável de probe travado: quarentena é conservadora e não deve ser liberada por alteração manual de banco. Esta entrega não presume que o suporte sintético comprove os termos de assinatura, formato real da CLI, custódia, refresh ou capacidade disponível.

Referências: RF-10, RF-12, RF-30, RF-55; RNF-13/14; T13/T26/T31/T39, com cobertura apenas da fronteira sintética descrita. Nenhum gate completo aprovado.

## Correções da revisão cruzada

O replay de uma observação expirada agora retorna status/saldo desconhecidos, mantendo recibo e TTL originais sem chamar novamente o coletor. `collect`, `latest` e `Control.view` compartilham `projectProviderSnapshot`: validação estrita/whitelist, origem sintética delimitada e digest obrigatório antes de projetar campos. A projeção administrativa não espalha mais um snapshot JSON cru nem aceita campos futuros/secretos extras, mesmo que alguém recompute seu digest.

A prova existente foi ampliada sem bateria adicional: replay após expiração não devolve percentual antigo e não chama probe; snapshot adulterado com campo secreto extra e digest recalculado é recusado por `view` e `latest`. `provider-replay-projection-final-20261102.log`: teste integrado único aprovado, exit 0. A mudança não libera probes incertos ou concede disponibilidade por tempo.
