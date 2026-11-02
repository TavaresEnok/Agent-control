# Autoria e preview de planos do gerente — 02/11/2026

Implementação na cópia isolada. Referências: RF-15, RF-16, RF-17–RF-21, RF-50. Não é homologação de planejamento com modelo real nem autorização de execução dinâmica.

## Entregue

- `upstream/cezar/packages/contract/src/agent-control-plans.ts`: contrato Zod compartilhado Node-free, exportado pelo pacote de contrato e pelo api-client nativos. Tarefas incluem dependências, referências de objetivo/entrada/saída/aceite, caminhos literais autorizáveis, revisão de qualidade, destino e limite de correções de 0 a 5. Não aceita shell, credenciais, runner, modelo, sessão continuada ou extensões arbitrárias.
- `src/planning.ts`: rejeita ciclos, IDs/saídas ambíguos, dependências ausentes e consumo de saída sem ancestral declarado. Compila o modelo no **grafo Cezar existente**, usando `graphIssues`, `graphToSteps` e `workflowDefSchema`; não cria scheduler. Forks têm até quatro branches, limite atual do upstream. Mais tarefas são distribuídas em blocos estáticos. Escritas sobrepostas são serializadas conservadoramente. As integrações são serializadas e preservam a exigência posterior de CAS; não se presume que branches distintas possam ser combinadas sem revalidação.
- Para cada tarefa são gerados bindings de implementação, QA obrigatório, 1–3 revisões e juiz quando exigido pela política, antes da integração. Sessões são declaradas novas e a fonte do artefato é a mesma implementação. **Esses bindings não substituem recibos físicos, assinatura de verificação nem evidência de independência em execução.**
- `ManagerPlans.publish/list/read`: propostas imutáveis, revisão CAS e repetição idempotente, ACL, fencing de época/lease, pausa e admissão vigentes. Propostas usam numeração própria e não substituem `ac_frozen_plans`/intenções em andamento. Nenhuma proposta insere outbox, operação ou grant.
- `db/migrations/032_manager_plans.sql`: snapshots e compilações com hashes, vínculo de versão anterior e trigger de imutabilidade.
- `src/planning-api.ts`: família Hono a montar após a autenticação pai e antes do fallback, via `app.route('/api/v1/ac', createPlanningApi(ledger,runtime.projectId,manager))`. Lista, leitura por revisão e publicação autenticadas; escopo de projeto, limite de 128 KiB, schemas estritos e manager resolvido no servidor. `Authority` no payload é recusada. Nunca expõe endpoint de execução.
- `AgentControlManagerPlans`, incluído nos Settings: versões, contratos e preview somente leitura. Reutiliza `GraphNodeView`, `autoLayout`/Dagre e React Flow originais. Não cria outro editor. Não mostra progresso fictício, não tem botão de disparo nem troca o plano ativo. A UI declara quando uma proposta ainda aguarda integração ao executor de entregas.

## Verificação executada

Node 22 da bancada, PostgreSQL real em banco temporário aleatório exclusivo da suíte e componentes de validação Cezar reais; nenhuma assinatura/inferência de IA.

1. `docker compose -f deploy/compose.lab.yml exec -T runtime npm run typecheck` — exit 0, após inclusão do serviço/API/contrato.
2. `docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/planning.test.ts` — 3 testes passaram, 0 skips. Evidência primeira compilação/PG: `docs/validation/evidence/manager-planning-focused-first-20261102.log`.
3. Mesma suíte, após adicionar a fronteira HTTP Hono: 3 testes passaram, 0 skips, exit 0; `docs/validation/evidence/manager-planning-api-final-20261102.log`. Abrange autenticação do middleware de fixture, escopo de outro projeto mesmo para o titular, body excessivo, recusa de autoridade enviada pelo cliente, list/read/propose, CAS, pausa, takeover do mesmo perfil, imutabilidade, viewer somente leitura e ausência de efeitos/outbox/grants.

O middleware de autenticação do teste HTTP usa bearer sintético fixo; não é prova de OAuth. O teste não inicia RunManager, workers ou modelos e não prova execução das branches. Tipos/build final do frontend ficam agrupados na validação de integração do agente principal, evitando builds repetidos.

## Fronteira de execução e próximo passo

A compilação é deliberadamente marcada `admission: managed-delivery-adapter-required`. A factory atual continua admitindo somente os fluxos fixos congelados. Isso evita transformar a presença de um grafo válido em permissão de executar shells ou contornar a política.

Para ativar propostas no runtime, a integração precisa congelar a versão e os bindings junto da intenção; adicionar identidade de subentrega/task/artifact/grant aos efeitos; resolver os nós dinâmicos no wrapper de `EngineeringStages`; reconciliar o mesmo conjunto após crash; e revalidar QA/revisão/CAS por tarefa. Uma nova proposta após reprovação deverá consumir o orçamento de correções do contrato anterior e produzir artefato novo; `maxCorrections` já limita o contrato, mas **não há loop de correção ativo neste incremento**. Não basta trocar `workflowFor` por um JSON arbitrário.

O endpoint de planejamento está pronto para uso por integração de gerente autorizada, sem abrir nova inferência. Fonte semântica de referências E2EE, interface de autoria livre e execução dinâmica permanecem pendentes. O preview mostra o grafo proposto, não o run aceito.

## Preservação e reversão

Sem alterações em serviços operacionais, filas, contas, logins, `.state` operacional ou projetos existentes. Não foi feito push/commit. Remover o mount da família e o componente dos Settings desativa a nova superfície sem alterar runs. A migração é aditiva e as propostas são imutáveis; não apagar versões para simular rollback.

## Continuação: comparação e restauração de propostas

O serviço/API também compara versões imutáveis (tarefas adicionadas/removidas e campos alterados, objetivo, restrições e origem) e restaura uma versão histórica **como nova proposta**. A restauração verifica ACL/manager/pausa/admissão e revisão CAS, preservando a origem no audit da transação. Não altera intenção aceita nem plano congelado. O preview mostra as diferenças e oferece a restauração explicitamente; uma lista desatualizada provoca conflito, nunca substituição silenciosa.

Prova adicional focada: `manager-planning-restore-final-20261102.log`, 3 testes passaram/0 skips/exit 0, com comparação de contratos, restauração idempotente, conflito e pausa. Ajustada a fixture `plan(contextId:string=...)` após o retorno explícito `string` de `Ledger.createContext` expor inferência indevida de UUID. O log negativo integrado é preservado pelo agente principal.

## Continuação: coletores e observabilidade visual

- `agent-control-operations.ts`: schemas Node-free compartilhados de snapshots normalizados, vínculos/adaptadores e métricas agregadas.
- `AgentControlProviderCollectors`, montado na Settings existente: saldo exibido somente quando informado e dentro do TTL; ocultação ao expirar; estados pending/uncertain; vínculo via `provider.bind` assinado existente, somente administradores/titulares elegíveis. A revisão carregada na seleção fica fixa; mudança concorrente exige recarga explícita antes de salvar. Não cria login nem coleta automaticamente.
- `AgentControlObservability`, montado com `enabled=canConfigureCapacity`: consulta o agregado protegido `/api/v1/ac/observability`; mostra concessões, espera, lease, admissão e disco medido. Sem configuração/medição, mostra indisponibilidade; nunca um espaço estimado de zero. Não soma scopes sobrepostos como jobs únicos nem chama a lease de prova de processo saudável.
- Teste UI focado `agent-control-provider-operations.test.tsx`: expiração, CAS de edição, ocultação de configuração de não administrador e ausência de fetch agregado quando desabilitado. Execução e build finais agrupados com o agente principal, evitando baterias repetidas.

## Correção de integração detectada na revisão cruzada

O middleware inicial da família de propostas era amplo demais quando montado no gateway: interceptava o ingresso público de login. A contraprova foi executada antes da correção (`manager-planning-login-regression-red-20261102.log`, exit 1, 401≠200), preservando a falha. `planning-api.ts` agora autentica somente as rotas de propostas e limita os bodies somente nos POST próprios. A regressão verde passou 3/3 sem skips/exit 0 em `manager-planning-login-regression-green-20261102.log`. A fronteira pública não permite operações administrativas; somente deixa o login alcançar seu handler original.

A variante inicial `default` do botão do preview foi corrigida para `primary`, admitida pelo Button nativo Cezar. O log negativo do build integrado é mantido pelo agente principal. Nenhuma asserção ou erro de compilação foi ocultado.
