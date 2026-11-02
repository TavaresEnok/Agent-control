# Registry de gerentes — 02/11/2026

Implementado `src/managers.ts`, integrado ao launcher sintético existente `src/lab-main.ts`. Não há novo scheduler, novo chat, inferência ou ativação de conta real. O gateway administrativo de produto permanece sem gerente automático.

## Ciclo e fronteira de autoridade

`ManagerRegistry.start()` faz singleflight local por contexto e configuração (principal, projeto, sessão, perfil, versão/variante e fingerprint da chave). Requisições locais simultâneas idênticas compartilham a mesma inicialização; conflito de configuração é recusado. A autoridade de exclusão entre processos continua exclusivamente `Ledger.acquire()` no PostgreSQL: cada aquisição, inclusive do mesmo perfil, recebe instância nova e epoch monotônica.

Antes de adquirir e antes de expor o endpoint como running, valida ACL de escrita, projeto do runtime, vínculo exato de sessão/principal e autorização de `ContextKeys`. A factory reutiliza `HappierEndpoint`; a registry não decide próximos nós e não cria loop de dispatch ou heartbeat concorrente com o endpoint nativo.

`authority()` é uma dica síncrona para a API, não autorização de efeito. Toda operação continua exigindo fencing PG. `status()` revalida ACL/link/chave/epoch e fecha o endpoint se perdeu autorização. Uma autoridade anteriormente retornada nunca contorna `Ledger.fence()`.

Falha de início e stop fecham o endpoint, zeram sua cópia de chave e expiram a lease **somente** quando contexto, instance e epoch ainda correspondem à aquisição daquele registro. Parada de gerente antigo não expira sucessor. Nenhum grant, pausa, checkpoint ou trabalho incerto é apagado/liberado pelo lifecycle. Erros arbitrários da factory são normalizados para evitar devolver detalhes de credenciais.

O desligamento invalida a cópia da chave imediatamente e tenta expirar a lease antes de aguardar o fechamento do endpoint. Falha na expiração é reportada como necessidade de limpeza, mas não impede a tentativa de fechamento; a lease remanescente depende do prazo natural e do fencing, sem liberar grants.

## Custódia e shutdown

Cada início recebe cópia privada dos 32 bytes de chave antes de qualquer await. A factory só recebe essa cópia; stop/falha/close não zeram a chave do chamador nem a cópia de outro contexto/gerente. A registry não grava nem devolve token/chave no PG, status ou logs. A factory nativa mantém bearer no domínio confiável já existente.

O launcher de laboratório substitui arrays manuais de endpoints/aquisição por essa registry, preservando o retry limitado de `MANAGER_ACTIVE` e usando a callback de authority da registry na API. Após copiar chaves nos endpoints, zera o buffer temporário do launcher. O shutdown tenta fechar registry, runtime e banco mesmo se uma etapa falhar; emite somente código sanitizado de reconciliação.

Se uma factory/start assíncrona estiver em trânsito quando stop ocorrer, a aquisição é invalidada e a chave é zerada imediatamente; a inicialização verifica cancelamento quando retorna e fecha novamente o endpoint. Isso não prova cancelamento de uma requisição de rede já enviada. O fencing continua recusando seus efeitos, e nenhuma capacidade física é liberada por analogia. Homologação física permanece pendente.

## Prova delimitada

`tests/managers.test.ts`: uma prova composta com banco PostgreSQL descartável e factory de callbacks sintéticos, sem servidor/conta/modelo real. Cobertura: duplicação concorrente cria um endpoint, falha de start fecha/zera sua cópia, retry incrementa epoch, takeover do mesmo perfil cria nova epoch, stop antigo preserva sucessor, grant incerto/pausa/checkpoint sobrevivem, revogação de chave remove autoridade e shutdown zera somente cópias próprias.

Uma factory sintética com `close` bloqueado verifica que a chave já foi zerada e o heartbeat da autoridade recusado antes da conclusão do fechamento. `docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/managers.test.ts`: exit 0, um teste, sem skips. `npm run typecheck` e `python3 tests/package_source_test.py`: exit 0. A prova usa banco descartável criado pelo teste e não comprova interrupção física de requisição em trânsito.

Logs negativos preservados: primeiro typecheck do teste usava `findLast` acima do target ES2022; corrigido. A primeira execução SQL consultava checkpoint na tabela errada; corrigida a fixture para `ac_checkpoints`. `manager-registry-final-20261102.log` registrou a prova composta aprovada. O root fará validação integrada da versão final, incluindo normalização de erro e shutdown.

Não declarada gerência semântica de IA, gerenciamento visual de credenciais reais, retorno automático entre provedores, homologação de dispositivo físico ou gate completo. O módulo fornece ciclo de vida/custódia/fencing integrado ao endpoint existente.
