# RF-35 — fatia de implementação paralela, 02/11/2026

Arquivos desta frente: migração035, `src/notifications.ts`, integração em
`src/happier.ts`, `tests/notifications.test.ts` e documentação operacional.
Não houve publicação externa, inferência, novo scheduler, mudança de conta,
credencial, chave autorizada, aprovação de código ou migração operacional.

Implementado:

- Mudanças semânticas duráveis por entidade/fonte/episódio, sem repetir status
  a cada seq/tick e sem guardar erro/texto livre no PG.
- Janela conservadora de 2 s para agrupar conclusões próximas e bloqueios
  importantes sem esperar a janela, usando o heartbeat existente.
- Ciphertext do lote na mesma outbox Happier, criação/vínculos atômicos,
  prioridade de usuário/bloqueio/conclusão e limites de backlog por tick.
- ACK estrito e recibo imutável; tentativa incerta mantém o mesmo ciphertext
  e localId. Revalidação de chave/vínculo/fence e heartbeat por publicação.
- Pausa preservada durante relay; sucessor pode continuar uma outbox durável;
  manager antigo é recusado. Sem inferir que ACK perdido significa não entrega.
- Contrato036 acordado com a frente de planejamento: somente intenções raiz
  entram no loop de dispatch do Happier; filhos pertencem ao RunManager pai.

Validação posterior em banco descartável criado pelo fixture, com a migração036
presente: `docker compose -f deploy/compose.lab.yml exec -T runtime node --import
tsx --test tests/notifications.test.ts` exit 0, um teste, zero skips; `docker
compose -f deploy/compose.lab.yml exec -T runtime npm run typecheck` exit 0.
Uma primeira execução do teste retornou exit 1: a autorização da chave expirou
intencionalmente a lease do sucessor antes do tick. O fixture foi corrigido para
autorizar a chave antes de adquirir o sucessor, e a execução seguinte passou.
O tick executou a consulta de raízes, mas o fixture não contém intenções e não
prova a exclusão comportamental de filhos. A estabilidade final da migração036
depende da frente proprietária.

Detalhes e limites em `docs/operations/NOTIFICATIONS.md`. Não foi testado push
nativo, aplicativo físico ou transporte real nesta fatia; trata-se de batching
no canal canônico existente. Não há conclusão total de RF-35/gate I6.
Nenhum stage/commit feito por este agente.
