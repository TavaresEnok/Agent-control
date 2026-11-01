# MATRIZ DE RASTREABILIDADE E CONFORMIDADE COM O PLANO MESTRE
## Plataforma Central Autônoma de Desenvolvimento de Software (Agent Control)

**Data da Auditoria:** 2026-11-01  
**Documento de Referência:** `PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md`  
**Estados Permitidos:**
- `Implementado e comprovado`
- `Implementado, mas defeituoso`
- `Parcialmente implementado`
- `Implementado de forma diferente`
- `Não implementado`
- `Não aplicável, justificadamente`
- `Não verificável`

---

## 1. Requisitos Funcionais (RF-01 a RF-54)

| ID | Esperado | Implementação Encontrada | Evidência | Estado | Problema | Correção |
|---|---|---|---|---|---|---|
| **RF-01** | Cadastrar projeto, repositório, branch, ambientes e diretórios autorizados pelo painel | Modelo `AcRemoteEnvironment` e `Project` existem no banco; faltam telas administrativas completas | `app/models/ac_remote_environment.rb` | Parcialmente implementado | Sem interface web/painel para cadastro completo | Implementar formulários no painel com validações completas |
| **RF-02** | Administrar vários projetos e destinos em uma única central | Schema suporta múltiplos ambientes e projetos por empresa | `ac_remote_environments` | Parcialmente implementado | Sem UI consolidada de gestão multisservidor | Criar dashboard de gestão multisservidor |
| **RF-03** | Criar contextos com histórico estável, preservado ao trocar conta/modelo/CLI | Modelo `AcWorkContext` persiste contexto independentemente do modelo ativo | `app/models/ac_work_context.rb` | Implementado e comprovado | — | Manter modelo e garantir persistência de chat associada |
| **RF-04** | Manter exatamente um gerente ativo autorizado por contexto | Método `assign_active_manager!` em `AcWorkContext` garante unicidade | `app/models/ac_work_context.rb:58` | Implementado e comprovado | — | Manter mecanismo e auditoria |
| **RF-05** | Representar duas contas do mesmo provedor sem usuários/empresas artificiais | `AgentCredential` e `AcExecutionProfile` associam contas distintas | `app/models/ac_execution_profile.rb` | Implementado e comprovado | — | Manter modelagem |
| **RF-06** | Autenticar por mecanismos oficiais de assinatura, sem API paga silenciosa | ADR-002 aprovada; bloqueia chamadas diretas a APIs pagas | `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md` | Implementado e comprovado | Falta integração de inferência real | Manter diretriz orçamentária ao conectar CLIs reais |
| **RF-07** | Configurar papel, perfil, esforço, conta, prioridade e substituições visualmente | Modelo `AcExecutionProfile` existe; tela visual administrativa ausente | `app/models/ac_execution_profile.rb` | Parcialmente implementado | Ausência de UI para edição de cadeias | Desenvolver página Inertia para edição de políticas |
| **RF-08** | Validar catálogo e combinações antes de publicar política; rejeitar modelo/esforço inexistente | Validação estrutural em `AcPolicyRevision` e `AcExecutionProfile` | `app/models/ac_policy_revision.rb:62` | Implementado e comprovado | — | Manter regras de validação |
| **RF-09** | Exibir versão aplicada e explicar por que um perfil foi escolhido ou recusado | `AcPolicyEngineService` gera eventos explicáveis de seleção e recusa | `app/services/ac_policy_engine_service.rb` | Implementado e comprovado | — | Conectar visualização desses eventos à UI |
| **RF-10** | Distinguir cota esgotada, limite temporário, auth inválida, rede e desconhecido | Modelo `AcQuotaObservation` com enumeradores de estados distintos | `app/models/ac_quota_observation.rb` | Implementado e comprovado | — | Manter granulometria de estados |
| **RF-11** | Respeitar permanência de trabalhador regular e devolução da reserva emergencial | Regras de permanência modeladas em `AcExecutionProfile` | `app/models/ac_execution_profile.rb:48` | Parcialmente implementado | Lógica de preempção não exercitada com processos reais | Implementar ciclo de preempção no dispatcher |
| **RF-12** | Retomar espera por capacidade quando houver evidência válida, preservando pausa | Sinais no Temporal (`resume_execution`) e modelo `AcTask` | `app/temporal/workflows/ac_task_execution_workflow.rb` | Parcialmente implementado | Retomada automática ativa não conecta daemon de probe | Ligar probe de cotas ao disparo de sinais Temporal |
| **RF-13** | Reservar capacidade global e local atomicamente, sem contar a mesma conta 2x | `AcCapacityGrant.grant_atomically!` com `SELECT FOR UPDATE` | `app/models/ac_capacity_grant.rb:68` | Implementado e comprovado | — | Manter trava transacional de alocação |
| **RF-14** | Distribuir vagas entre chats com prioridade e justiça, evitando fome indefinida | Resolução em `AcAdmissionService` e contagem de vagas | `app/services/ac_admission_service.rb` | Parcialmente implementado | Algoritmo de justiça (fair share) simplificado | Implementar fila de prioridade com timestamp de espera |
| **RF-15** | Gerar planos versionados com dependências, contratos e critérios de aceite | Modelo `AcPlan` com versionamento e hash SHA-256 | `app/models/ac_plan.rb` | Implementado e comprovado | — | Manter estrutura |
| **RF-16** | Executar tarefas independentes em paralelo e serializar dependências | DAG em `AcPlan#ready_tasks` e `advance_dag!` | `app/models/ac_plan.rb:65` | Implementado e comprovado | — | Manter resolução do DAG |
| **RF-17** | Consultar especialista antes da implementação quando o risco justificar | Papel `:specialist` cadastrado em perfis e DAG | `app/models/ac_task.rb:25` | Parcialmente implementado | Invocação automática de especialista não integrada ao workflow | Disparar etapa de especialista em tarefas de alto risco |
| **RF-18** | Executar QA e revisão independentes quando exigidos pelo template | `AcReviewService` com validação de papéis `:reviewer` e `:qa` | `app/services/ac_review_service.rb` | Implementado e comprovado | — | Manter obrigatoriedade por classe de risco |
| **RF-19** | Vincular pareceres e verificações a commits e hashes exatos, invalidando stale | `AcReviewVerdict` fixa `artifact_hash` e invalida anteriores | `app/services/ac_review_service.rb:75` | Implementado e comprovado | — | Manter validação de hash imutável |
| **RF-20** | Retornar entrega reprovada à implementação, preservando achados | `task.reject_back_to_implementation!` mantém achados | `app/services/ac_review_service.rb:59` | Implementado e comprovado | — | Manter fluxo de retrabalho |
| **RF-21** | Limitar ciclos de correção e falhas técnicas sem loops ilimitados | Limite `AcTask::MAX_ATTEMPT_COUNT = 5` com transição para falha | `app/models/ac_task.rb:14` | Implementado e comprovado | — | Manter barreira de tentativas |
| **RF-22** | Usar workflow durável para despacho, esperas, cancelamento e conclusão | `AcTaskExecutionWorkflow` registrado no Temporal | `app/temporal/workflows/ac_task_execution_workflow.rb` | Implementado, mas defeituoso | Despacho não inicializa processo real (apenas gera string) | Conectar atividade a `Open3`/Docker de verdade |
| **RF-23** | Reconciliar reinícios, confirmações perdidas e processos órfãos antes de repetir | `AcExecution#reconcile_outcome!` com validação de época | `app/models/ac_execution.rb:87` | Implementado, mas defeituoso | Atividade de despacho gera handle fake e mocka reconciliação | Conectar supervisor a PIDs e containers reais |
| **RF-24** | Pausar, retomar, cancelar e drenar com semânticas distintas e visíveis | Sinais `pause_execution`, `resume_execution`, `cancel_execution` | `app/temporal/workflows/ac_task_execution_workflow.rb` | Implementado e comprovado | — | Manter semântica de sinais |
| **RF-25** | Integrar somente artefato aprovado, com proteção contra tentativa antiga e mudança da base | `AcIntegrationService` valida CAS de branch e aprovação | `app/services/ac_integration_service.rb` | Implementado, mas defeituoso | Integração atualiza coluna de BD, mas não executa Git merge | Adicionar comandos Git reais de integração |
| **RF-26** | Executar CLIs na central e operações em 2 servidores sem login de IA no destino | `AcRemoteGatewayService` e `OpenSshTransport` | `app/services/ac_remote_gateway_service.rb` | Implementado, mas defeituoso | Execução síncrona não cria supervisor nem arquivos de saída | Criar script wrapper remoto com nohup e traps de saída |
| **RF-27** | Preservar identidade e resultado de operação SSH após desconexão | Modelo `AcRemoteOperation` com `remote_job_id` | `app/models/ac_remote_operation.rb` | Implementado, mas defeituoso | `status_query_cmd` procura arquivo `.exit` que nunca é gravado | Gravar `.exit` no término do processo remoto |
| **RF-28** | Isolar worktrees, processos, credenciais e redes conforme perfil | `AcWorktreeManagerService` aloca lease | `app/services/ac_worktree_manager_service.rb` | Implementado, mas defeituoso | Não cria worktree Git real (apenas gera string de path) | Executar `git worktree add` físico em diretório seguro |
| **RF-29** | Oferecer capacidade administrativa autorizada ao gerente sem repassar ao trabalhador | Restrição de papéis em perfis de execução | `app/models/ac_execution_profile.rb` | Parcialmente implementado | Não há isolamento a nível de SO entre processos de workers | Isolar trabalhadores em containers com UID não privilegiado |
| **RF-30** | Exibir uso, cota e renovação por conta quando observáveis | Modelo `AcQuotaObservation` existe | `app/models/ac_quota_observation.rb` | Parcialmente implementado | Sem interface visual para acompanhamento de cotas | Criar painel visual de cotas e consumo |
| **RF-31** | Produzir auditoria de decisões, trocas, tentativas, revisão e integração | `AcDecisionAuditEvent` append-only bloqueia update/delete | `app/models/ac_decision_audit_event.rb` | Implementado e comprovado | — | Manter imutabilidade de eventos |
| **RF-32** | Permitir percursos essenciais de configuração e operação pelo celular | `MobileSetupWizard.tsx` e `PlanGraph.tsx` | `app/frontend/pages/AgentControl/` | Implementado, mas defeituoso | Wizard móvel submete para comando ignorado no backend | Conectar handler de criação de projetos no controller |
| **RF-33** | Importar histórico, planos e evidências dos Paseos sem duplicar trabalho | `AcPaseoImportService` existe em modo read-only | `app/services/ac_paseo_import_service.rb` | Parcialmente implementado | Serviço não é acionado por nenhuma rota, UI ou CLI | Criar rake task ou endpoint para importação real |
| **RF-34** | Exportar configuração e relatórios sem credenciais; backup e restauração | `AcBackupService` exporta manifesto com digests | `app/services/ac_backup_service.rb` | Parcialmente implementado | `restore_from_manifest` não restaura dados no banco | Implementar ingestão real dos dados do manifesto |
| **RF-35** | Notificar conclusão agrupada e bloqueio relevante, com deduplicação | — | Não implementado | Não implementado | Serviço de notificações não desenvolvido | Implementar disparadores de notificação |
| **RF-36** | Alterar configuração pelo chat usando a mesma API do painel | — | Não implementado | Não implementado | Sem endpoint ou bridge para chat de alteração de config | Criar intent handlers correspondentes |
| **RF-37** | Editor livre de grafos e editor móvel por etapas (P1) | `PlanGraph.tsx` simplificado em lista de cards | `app/frontend/pages/AgentControl/PlanGraph.tsx` | Implementado de forma diferente | Lista de cards em vez de canvas livre (permitido em P0) | Evoluir para canvas gráfico interativo em P1 |
| **RF-38** | Permitir equipe com vários revisores e julgador dentro dos limites (P1) | `AcReviewCouncilService` com ondas e arbitragem | `app/services/ac_review_council_service.rb` | Implementado, mas defeituoso | Adjudicação gera commit SHA sintético e não chama LLMs | Conectar revisores a modelos reais |
| **RF-39** | Operar diretamente em worktree remota via adaptador homologado (P1) | — | Não implementado | Não implementado | Escopo postergado para P1 | Planejado para fase posterior |
| **RF-40** | Coletar e exportar uso, perfil, tentativas, tempo e retrabalho | Tabelas retêm histórico de tentativas e execuções | `ac_executions` / `ac_decision_audit_events` | Parcialmente implementado | Sem relatório consolidado de eficiência | Desenvolver query de rollup e exportação de métricas |
| **RF-41** | Separar aprovação da entrega, integração, publicação e deploy | `AcReviewService` e `AcIntegrationService` separados | `app/services/` | Implementado e comprovado | — | Manter segregação de serviços |
| **RF-42** | Validar edição concorrente de políticas e disponibilizar reversão | `AcPolicyRevision` com número incremental e status | `app/models/ac_policy_revision.rb` | Implementado e comprovado | — | Manter versionamento imutável |
| **RF-43** | Cadastrar templates reutilizáveis por projeto sem duplicar contas globais | Schema de projetos desacoplado de credenciais globais | `db/schema.rb` | Parcialmente implementado | Sem tabela formal de templates de plano | Criar modelo `AcPlanTemplate` |
| **RF-44** | Preservar pausas e bloqueios durante importação, reinício e recuperação | `AcRecoveryService.preserve_pauses!` | `app/services/ac_recovery_service.rb:73` | Implementado e comprovado | — | Manter preservação de pausas |
| **RF-45** | Exigir a mesma autorização de tentativa em todos os pontos de entrada | `AcAdmissionService.admit_execution!` centraliza checagem | `app/services/ac_admission_service.rb` | Implementado e comprovado | — | Garantir que controllers chamem este serviço |
| **RF-46** | Compartilhar autoridade de capacidade entre antigo/novo durante coexistência | `AcSharedCapacityCoordinatorService` | `app/services/ac_shared_capacity_coordinator_service.rb` | Implementado, mas defeituoso | Conta todas as reservas da empresa sem filtrar conta; sem lock | Corrigir query de contagem e adicionar lock |
| **RF-47** | Reservar recursos por etapa e liberar após encerramento reconciliado | Atividades `ac_admit_task` e `ac_release_capacity` | `app/temporal/workflows/ac_task_execution_workflow.rb` | Implementado e comprovado | — | Manter bloco ensure no workflow |
| **RF-48** | Aceitar evidências apenas do executor confiável e condicionar integração | Validações em `AcIntegrationService` | `app/services/ac_integration_service.rb:98` | Implementado e comprovado | — | Manter validação de identidade |
| **RF-49** | Impedir acesso cruzado entre contas e acesso de agentes à administração | Validação de locatário em models | `app/models/ac_execution_profile.rb:68` | Implementado, mas defeituoso | API sem auth permite bypass de tenant (`Company.first`) | Corrigir controller com autenticação rígida |
| **RF-50** | Exibir grafo de execução com estado, dependências e sumário estatístico | `AcDagGraphService` e `PlanGraph.tsx` | `app/services/ac_dag_graph_service.rb` | Implementado e comprovado | — | Manter projeção de leitura do grafo |
| **RF-51** | Materializar com segurança projeto Git inicialmente acessível só por SSH | `OpenSshTransport` | `app/services/agent_control/open_ssh_transport.rb` | Parcialmente implementado | Teste unitário de SSH pulado por falta de binário no container | Instalar cliente OpenSSH na imagem Docker de execução |
| **RF-52** | Atualizar workers com versões e restaurar central em modo reconciliação | `AcRecoveryService.enter_recovery_mode!` | `app/services/ac_recovery_service.rb` | Implementado, mas defeituoso | Modo de recuperação usa variável em memória volátil | Persistir flag de recuperação no banco/Redis |
| **RF-53** | Deduplicar comandos móveis pela identidade da intenção (`intent_id`) | `AcCommandDeduplicationService` e `AcClientCommand` | `app/services/ac_command_deduplication_service.rb` | Implementado e comprovado | — | Manter deduplicação transacional |
| **RF-54** | Garantir único escritor autorizado por worktree e neutralizar antigo | `AcWorktreeManagerService` | `app/services/ac_worktree_manager_service.rb` | Implementado, mas defeituoso | Apenas gerencia tokens no banco, sem worktree física | Adicionar comandos Git para isolamento de worktree |

---

## 2. Requisitos Não Funcionais (RNF-01 a RNF-15)

| ID | Requisito | Critério Esperado | Situação Encontrada | Estado | Problema Identificado |
|---|---|---|---|---|---|
| **RNF-01** | Continuidade | Reiniciar componentes não perde comandos confirmados | Comandos salvos em `ac_client_commands` com índice único | Implementado e comprovado | Estado persistido sobrevive a reinício |
| **RNF-02** | Consistência | Um único proprietário por transição de estado e reconciliação | Transições transacionais com `lock("FOR UPDATE")` no banco | Implementado e comprovado | Transições de máquina de estados consistentes |
| **RNF-03** | Isolamento | Trabalhador não acessa conta alheia nem admin da central | Validações nos modelos presentes; API externa vulnerável | Implementado, mas defeituoso | Controller sem autenticação quebra o isolamento de locatário |
| **RNF-04** | Experiência móvel | Fluxos utilizáveis em telas de 360px a 390px sem hover | CSS Modules com viewports móveis em `MobileSetupWizard` e `PlanGraph` | Implementado e comprovado | Layout responsivo verificado |
| **RNF-05** | Observabilidade | Tarefa parada informa motivo, evidência e responsável | Colunas `error_details`, `rejection_reason` e auditoria presentes | Implementado e comprovado | Campos estruturados gravados no BD |
| **RNF-06** | Manutenibilidade | Adaptadores, políticas e workflows versionados | Versionamento de políticas e workflows Temporal implementados | Implementado, mas defeituoso | Arquitetura bifurcada (Aixle Flow vs Ac*) gera custo dobrado |
| **RNF-07** | Eficiência | Eventos agrupados e economia de contexto | Mapeamento em `AcDagGraphService` agrega sumários de tarefas | Implementado e comprovado | Projeção em payload único consolidado |
| **RNF-08** | Segurança de dados | Segredos não aparecem em logs, prompts ou histórico | `AcQuotaService` e `OpenSshTransport` redigem senhas e tokens | Implementado e comprovado | Chaves privadas não são persistidas em texto claro |
| **RNF-09** | Reprodutibilidade | Versões da base, CLI, modelo e política registradas | Registros retêm `policy_revision_number` e `model_id` | Implementado e comprovado | Rastreabilidade mantida nos registros |
| **RNF-10** | Recuperação | Backup com restauração demonstrada | `AcBackupService` exporta; `AcRecoveryService` falha na restauração | Implementado, mas defeituoso | Restauração não insere entidades de volta ao banco de dados |
| **RNF-11** | Capacidade | Admissão considera vagas e cotas | Bloqueio atômico em `AcCapacityGrant` e limites de pool | Implementado e comprovado | Rejeição atômica de excesso de capacidade |
| **RNF-12** | Responsividade | Aceite de comando em até 2s e evento em até 5s | Deduplicação transacional e endpoints rápidos em memória/SQL | Implementado e comprovado | Latência de API < 100ms em testes locais |
| **RNF-13** | Compatibilidade | Atualização de CLI/modelo com contrato | ADR-002 fixou CLIs suportadas | Implementado e comprovado | Contrato documental estabelecido |
| **RNF-14** | Transparência | Cota desconhecida nunca é indicada como disponível | `AcQuotaObservation` possui estado explícito `:unknown` | Implementado e comprovado | Modelo distingue estados com fidelidade |
| **RNF-15** | Portabilidade | Planos, políticas e histórico exportáveis em JSON | `AcBackupService.export_manifest` exporta tabelas em JSON | Implementado e comprovado | Manifesto estruturado exportável |

---

## 3. Avaliação das Decisões Arquiteturais e Decisões Abertas

| ID | Descrição | Avaliação da Auditoria | Estado | Parecer Técnico |
|---|---|---|---|---|
| **D-01** | Base Kandev (condicionada a G0) | Descartada no G0 per ADR-001 em favor do Aixle Flow | Não aplicável, justificadamente | Decisão documentada na ADR-001 |
| **D-02** | Alternativa: Aixle Flow | Adotada formalmente per ADR-001 | Implementado de forma diferente | Adotou a base, mas criou um subsistema paralelo (`Ac*`) em vez de estender o upstream |
| **D-03** | Cezar: reaproveitamento seletivo | Descartado no G0 por complexidade de extração | Não aplicável, justificadamente | Decisão coerente com a simplificação do stack |
| **D-04** | Preservar a stack da base (Rails + Temporal) | Stack preservada (Ruby on Rails + Temporal Ruby SDK) | Implementado e comprovado | Stack coerente com a base adotada |
| **D-05** | Distinguir consenso de homologação | Auditoria confirmou que a plataforma não está homologada | Implementado e comprovado | O presente parecer formaliza a reprovação para homologação |
| **D-06** | Temporal e celular cedo | F2 (Temporal) e F5 (Mobile) implementados nas fases iniciais | Implementado e comprovado | Sequência cronológica respeitada |
| **DA-01** | Qual base deve ser a primeira avaliada? | Resolvida no G0 (Aixle Flow adotado) | Implementado e comprovado | Registrada em ADR-001 |
| **DA-02** | Quando introduzir Temporal? | Introduzido em F0 e consolidado em F2 | Implementado e comprovado | Workflows registrados |
| **DA-03** | O canvas livre bloqueia P0? | Resolvida: formulários e lista de cards adotados em P0 | Implementado e comprovado | Canvas livre postergado para P1 |
| **DA-04** | Desenvolvimento central ou remoto? | Central padrão com execução remota via SSH | Implementado e comprovado | Resolvido conforme diretriz |
| **DA-05** | Onde vivem as políticas? | Módulo interno `AcPolicyEngineService` | Implementado e comprovado | Serviço interno adotado sem microserviço desnecessário |
| **DA-06** | Contabilização de QA/especialista | Vagas por etapa limitadas no conselho multi-avaliador | Implementado e comprovado | Teto de 2 vagas concorrentes em F8 |
| **DA-07** | Significado do limite de 8 trabalhadores | Resolvido per ADR-002 e regras de pool de empresa | Implementado e comprovado | Limite vinculado à credencial e cota |
| **DA-08** | Perfis iniciais de QA/revisor | Claude Sonnet Alto (revisor) e perfis configuráveis | Implementado e comprovado | Parametrizado nos perfis |
| **DA-09** | Exposição e distribuição do produto | Acesso local / rede confiável inicialmente | Implementado, mas defeituoso | Acesso sem autenticação na API do Agent Control |
| **DA-10** | Evidência de cota disponível | Modelada em `AcQuotaObservation` com estado `:unknown` | Implementado e comprovado | Semântica de cota desconhecida respeitada |

---

## 4. Avaliação dos Gates e Fases de Engenharia

| Gate | Fase | Status Declarado na IA Anterior | Status Real na Auditoria | Justificativa do Veredito |
|:---:|---|:---:|:---:|---|
| **G0** | F0 — Escolha e Prova Estrutural | APROVADO | **APROVADO COM RESSALVAS** | Comprovou critérios eliminatórios em laboratório, mas deixou de testar cliente SSH no container de produção. |
| **G1** | F1 — Domínio e Políticas | APROVADO | **APROVADO COM RESSALVAS** | Modelos relacionais e auditoria consistentes, mas desconectados do motor nativo do Aixle Flow. |
| **G2** | F2 — Execução Durável | APROVADO | **REPROVADO** | O workflow Temporal e o despacho não executam nenhum processo real; simulação com `exit_code: 0` injetado no teste. |
| **G3** | F3 — Equipe, DAG e Qualidade | APROVADO | **REPROVADO** | O workflow de plano possui condicionais para testes (`trigger_review_for_task_id`); não executa trabalho real nem faz Git merge. |
| **G4** | F4 — Ambientes Remotos e SSH | APROVADO | **REPROVADO** | O despacho de job é síncrono e não cria o arquivo `.exit` remoto; consulta pós-desconexão é disfuncional no mundo real. |
| **G5** | F5 — Produto Operável e Mobile | APROVADO | **REPROVADO** | O assistente móvel envia comando `setup_project_wizard` que cai no `else` e é sumariamente ignorado pelo backend. |
| **G6** | F6 — Homologação, Coexistência e Piloto | APROVADO | **REPROVADO** | `restore_from_manifest!` não restaura entidades no banco; modo de recuperação volátil em memória; piloto foi simulado. |
| **G7** | F7 — Migração e Cutover | APROVADO | **REPROVADO** | Migração e cutover apenas alteram strings no banco; nenhum dado ou processo foi migrado de projetos reais como Ajust ERP e NexoISP. |
| **G8** | F8 — Extensões P1 e Conselho | APROVADO | **REPROVADO** | Julgamento cria commits falsos (`commit_adj_...`) sem interagir com repositórios ou modelos de linguagem reais. |
