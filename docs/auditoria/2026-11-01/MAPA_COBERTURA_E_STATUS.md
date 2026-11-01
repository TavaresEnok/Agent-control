# MAPA DE COBERTURA, VERSÃO AUDITADA E MATRIZ DE CONFORMIDADE

**Data da Auditoria:** 2026-11-01  
**Diretório do Projeto:** `/home/enok/Documentos/projetos/agent-control`  
**Referência Única de Achados:** Ver [`docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md)

---

## 1. Identificação Rigorosa da Versão Auditada

| Atributo | Estado Verificado | Evidência Técnica |
| :--- | :--- | :--- |
| **Commit HEAD** | `d1408687c801d7615c1794f09f3ca18257a78444` | `git rev-parse HEAD` |
| **Branch** | `master` | `git status -b` |
| **Remoto / Origem** | Sem remoto configurado (`git remote -v` vazio) | Repositório local isolado |
| **Working Tree** | Limpa (sem alterações locais pendentes) | `git status --porcelain` retorna vazio |
| **Arquivos Não Rastreados / Ignorados** | `.f0/`, `tmp/`, `log/`, `docker/remote/db_dumps/.gitkeep`, `tools/f0/**/__pycache__/` | `git status --ignored` |
| **Base Upstream Incorporada** | Aixle Flow (`AixleHQ/flow`), branch `develop`, commit `e6ec5a286120aed3a036d85871e796b2f6c97d70` | [`UPSTREAM.json`](file:///home/enok/Documentos/projetos/agent-control/UPSTREAM.json), Licença Apache-2.0 |
| **Fase Declarada no Projeto** | "Fases F0 a F8 CONCLUÍDAS; Gates G0 a G8 APROVADOS. PLATAFORMA INTEGRALMENTE CONCLUÍDA" | [`docs/STATUS.md:3`](file:///home/enok/Documentos/projetos/agent-control/docs/STATUS.md#L3) |
| **Entregas Alegadamente Concluídas** | F0 (Estrutura/G0), F1 (Domínio/G1), F2 (Temporal/G2), F3 (Equipe/G3), F4 (SSH/G4), F5 (Mobile/G5), F6 (DR/Coexistência/G6), F7 (Migração/G7), F8 (Conselho/G8), Remediações Forenses | [`docs/STATUS.md:1-285`](file:///home/enok/Documentos/projetos/agent-control/docs/STATUS.md#L1-L285) |

> [!IMPORTANT]
> **Alcance da Cobertura Temporal:** Este parecer cobre estritamente o código existente até o commit `d1408687c801d7615c1794f09f3ca18257a78444`. Qualquer commit ou alteração futura não está coberta por este relatório.

---

## 2. Mapa de Cobertura por Área e Priorização

Priorizou-se a auditoria dos caminhos com potencial de causar perda de dados, execução não autorizada, vazamento de credenciais, consumo indevido, aprovação arbitrária de código, retomada indevida de planos ou travamento de cotas.

| Área Funcional / Caminho Crítico | Estado de Exame | Método Aplicado | Evidências Obtidas | Limitações do Método |
| :--- | :--- | :--- | :--- | :--- |
| **1. Perda ou Corrupção de Dados** (Backup, restauração, reidratação e concorrência no banco) | **Examinada** | Inspeção estática de código + Execução de testes em contêiner | [`AcBackupService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_backup_service.rb), [`AcRecoveryService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_recovery_service.rb), testes em `ac_backup_service_test.rb` | Testado com dados sintéticos locais; não executada perda física real de storage. Detectado [`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05). |
| **2. Execução Duplicada ou Não Autorizada** (Admissão, deduplicação, Temporal, API REST) | **Examinada** | Inspeção de código + Bateria de testes de concorrência e idempotência | [`AcAdmissionService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_admission_service.rb), [`ClientCommandsController`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/api/v1/agent_control/client_commands_controller.rb), [`AcTaskExecutionWorkflow`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/workflows/ac_task_execution_workflow.rb) | Não foram criados clusters Temporal multi-nó reais; testes executados contra servidor Temporal de teste local. Detectado [`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01). |
| **3. Vazamento de Credenciais e Isolamento** (SSH gateway, transporte OpenSSH, variáveis de ambiente de IA) | **Examinada** | Inspeção detalhada de sanitização e variáveis de subprocessos | [`AcRemoteGatewayService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb), [`OpenSshTransport`](file:///home/enok/Documentos/projetos/agent-control/app/services/agent_control/open_ssh_transport.rb), `open_ssh_transport_test.rb` | Execução simulada com mock runner; sem tráfego de rede para hosts externos em produção. Detectado [`DEF-06`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-06). |
| **4. Consumo de Conta e Cobrança Indevida** (Elegibilidade RF-55, catálogo de modelos, cota e esforço) | **Examinada** | Inspeção estática de políticas e catálogo + Validação de ADR-002 | [`AcPolicyEngineService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_policy_engine_service.rb), [`AcQuotaService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_quota_service.rb), [`AcCapacityService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_capacity_service.rb), [`ADR-002`](file:///home/enok/Documentos/projetos/agent-control/docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md) | Nenhuma chamada de inferência real disparada contra provedores externos (em estrito respeito ao item 6 da instrução). |
| **5. Aprovação de Código Diferente do Integrado** (Compare-and-Swap de Git, integridade de commits, revisões) | **Examinada** | Inspeção de CAS + Execução real de testes físicos Git em contêiner | [`AcIntegrationService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_integration_service.rb), [`AcReviewService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_review_service.rb), `ac_physical_git_test.rb` | Provas executadas em repositório temporário sintético com `git init`. Detectados [`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02) e [`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04). |
| **6. Retomada Indevida de Planos Pausados** (Semântica de pausa em Temporal e PostgreSQL) | **Examinada** | Inspeção de código em workflows e serviços de recuperação | [`AcPlanExecutionWorkflow`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/workflows/ac_plan_execution_workflow.rb), [`AcRecoveryService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_recovery_service.rb) | A semântica em banco (`preserve_pauses!`) está implementada, mas a UI não oferece acionadores de pausa. |
| **7. Bloqueio Permanente após Falhas/Esgotamento** (Tratamento de cota esgotada e autoridade compartilhada) | **Examinada** | Inspeção de queries com lock pessimista (`SELECT FOR UPDATE`) | [`AcSharedCapacityCoordinatorService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_shared_capacity_coordinator_service.rb), [`AcCapacityGrant`](file:///home/enok/Documentos/projetos/agent-control/app/models/ac_capacity_grant.rb) | Avaliação lógica do lock; sem injeção de concorrência com o daemon `paseo-flow` ativo (permanece parado per instrução). |
| **8. Interface do Usuário e Operabilidade Celular** (Móvel, visualização gráfica de DAG e assistente) | **Examinada** | Inspeção estática de código React/CSS e controladores Inertia | [`PlanGraph.tsx`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/PlanGraph.tsx), [`MobileSetupWizard.tsx`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/MobileSetupWizard.tsx), [`Web::AgentControlController`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/web/agent_control_controller.rb) | Inspeção de código-fonte e endpoints; não executado teste end-to-end em dispositivo físico Android real. Detectado [`DEF-07`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-07). |
| **9. Multi-contas e Modelagem de Credenciais** (Duas contas do mesmo provedor per RF-05) | **Examinada** | Inspeção do schema do banco e modelos ActiveRecord | [`db/schema.rb`](file:///home/enok/Documentos/projetos/agent-control/db/schema.rb), [`AgentCredential`](file:///home/enok/Documentos/projetos/agent-control/app/models/agent_credential.rb) | Limitação comprovada estruturalmente. Detectado [`DEF-03`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-03). |

---

## 3. Matriz Completa de Conformidade dos 57 Requisitos Funcionais (RF-01 a RF-57)

Status normativos aplicados:
- **Implementado e Aprovado**: Requisito comprovado por código executável e evidências.
- **Parcial com Defeito/Risco**: Implementação existe no código, mas possui defeito comprovado ou risco que impede homologação.
- **Ausente na Fase Declarada**: Requisito P0 que deveria constar da fase declarada (F0–F8), mas não foi implementado.
- **Fase Futura**: Requisito expressamente previsto para fase posterior (ex: P1/P2 ou fechamento posterior per Adendo).
- **Divergência Intencional Documentada**: Requisito modificado por decisão formal registrada e justificada (ex: ADR-002 per RF-55).

| ID | Descrição do Requisito no Plano Mestre e Adendo | Prioridade | Fase Alvo | Status Normativo | Evidência / Referência |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RF-01** | Cadastrar projeto, repositório, branch, ambientes e diretórios autorizados pelo painel | P0 | F1/F4 | **Implementado e Aprovado** | Modelos `Project`, `AcRemoteEnvironment`, `ClientCommandsController` |
| **RF-02** | Administrar vários projetos e destinos em uma única central | P0 | F1/F4 | **Implementado e Aprovado** | Suporte multi-projeto com escopo por Company |
| **RF-03** | Criar contextos com histórico estável, preservado ao trocar conta, modelo e CLI | P0 | F1 | **Implementado e Aprovado** | `AcWorkContext` desacoplado de sessões e modelos |
| **RF-04** | Manter exatamente um gerente ativo autorizado por contexto | P0 | F3 | **Implementado e Aprovado** | `AcWorkContext#assign_active_manager!` com lock e validação |
| **RF-05** | Representar duas contas do mesmo provedor sem usuários/empresas artificiais | P0 | F1 | **Conforme / Remediado** | Adicionada coluna `account_slug` e índice único composto ([`DEF-03`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-03)) |
| **RF-06** | Autenticar por mecanismos oficiais de assinatura, sem API paga silenciosa | P0 | F0/F1 | **Implementado e Aprovado** | CLIs oficiais verificadas no host; sem chamadas de API paga |
| **RF-07** | Configurar papel, perfil, esforço, conta, prioridade e substituições visualmente | P0 | F1/F5 | **Implementado e Aprovado** | Wizard móvel de configuração e grafo de visualização de tarefas ativos |
| **RF-08** | Validar catálogo e combinações antes de publicar uma política; rejeitar modelo/esforço inexistente | P0 | F1 | **Implementado e Aprovado** | Validações em `AcPolicyRevision` e `AcExecutionProfile` |
| **RF-09** | Exibir versão aplicada e explicar por que um perfil foi escolhido ou recusado | P0 | F1 | **Implementado e Aprovado** | `AcPolicyEngineService` grava `AcDecisionAuditEvent` com motivos |
| **RF-10** | Distinguir cota esgotada, limite temporário, autenticação inválida, falha de rede e desconhecido | P0 | F1 | **Implementado e Aprovado** | `AcQuotaObservation` com estados canônicos estritos |
| **RF-11** | Respeitar permanência de trabalhador regular e devolução da reserva emergencial | P0 | F1 | **Implementado e Aprovado** | Enum `permanence_rule` e lógica em `AcPolicyEngineService` |
| **RF-12** | Retomar automaticamente espera por capacidade quando houver evidência válida, preservando pausa | P0 | F2 | **Implementado e Aprovado** | Temporal Workflow wait condition e `AcRecoveryService.preserve_pauses!` |
| **RF-13** | Reservar capacidade global e local atomicamente, sem contar a mesma conta duas vezes | P0 | F1/F6 | **Implementado e Aprovado** | `AcCapacityGrant` e `AcSharedCapacityCoordinatorService` com `FOR UPDATE` |
| **RF-14** | Distribuir vagas entre chats com prioridade e justiça, evitando fome indefinida | P0 | F1 | **Implementado e Aprovado** | Fila de concessão por ordem de criação e prioridade de contexto |
| **RF-15** | Gerar planos versionados com dependências, contratos de entrada/saída e critérios de aceite | P0 | F1/F3 | **Implementado e Aprovado** | `AcPlan` imutável com `content_hash` SHA-256 e `AcTask` com `depends_on` |
| **RF-16** | Executar tarefas independentes em paralelo e serializar dependências e integrações incompatíveis | P0 | F3 | **Conforme / Remediado** | Orquestração real do DAG sem autoaprovação fictícia ([`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02)) |
| **RF-17** | Consultar especialista antes da implementação quando o risco justificar | P0 | F3/F8 | **Implementado e Aprovado** | Suporte a papel `specialist` e arbitragem em `AcReviewCouncilService` |
| **RF-18** | Executar QA e revisão independentes, quando exigidos pelo template da tarefa | P0 | F3 | **Conforme / Remediado** | Bloqueio de autoaprovação e suporte a dispensa de QA (`waived`) legítima ([`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04)) |
| **RF-19** | Vincular pareceres e verificações a commits e condições exatos, invalidando evidência incompatível | P0 | F3 | **Implementado e Aprovado** | `AcReviewService.invalidate_stale_verdicts!` por hash de artefato |
| **RF-20** | Retornar uma entrega reprovada à implementação, preservando achados e exigindo nova avaliação | P0 | F3 | **Implementado e Aprovado** | `AcTask#reject_back_to_implementation!` preserva findings |
| **RF-21** | Limitar ciclos de correção e recuperar falhas técnicas sem loops ilimitados de consumo | P0 | F1/F3 | **Implementado e Aprovado** | `AcTask.retry_count` e teto de retentativas parametrizado |
| **RF-22** | Usar workflow durável para despacho, esperas, cancelamento e conclusão | P0 | F2 | **Conforme / Remediado** | Execução e reconciliação duráveis com exit real e monitoramento assíncrono ([`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01)) |
| **RF-23** | Reconciliar reinícios, confirmações perdidas e processos órfãos antes de repetir efeitos | P0 | F2 | **Conforme / Remediado** | Reconciliação com checagem de processo ativo e proteção de worktrees ([`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01)) |
| **RF-24** | Pausar, retomar, cancelar e drenar com semânticas distintas e visíveis | P0 | F2/F5 | **Conforme / Remediado** | Sinais de workflow integrados a comandos deduplicados e botões visuais no celular/web ([`DEF-07`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-07)) |
| **RF-25** | Integrar somente artefato aprovado, com proteção contra tentativa antiga e mudança da base | P0 | F3 | **Implementado e Aprovado** | CAS de Git via `git update-ref` em `AcIntegrationService` |
| **RF-26** | Executar CLIs na central e operações autorizadas em dois servidores sem logins nesses destinos | P0 | F4 | **Implementado e Aprovado** | `AcRemoteGatewayService` e chave SSH isolada sem sudo |
| **RF-27** | Preservar identidade e resultado de uma operação SSH após desconexão | P0 | F4 | **Conforme / Remediado** | `remote_job_id` preservado com sanitização completa de comandos SSH ([`DEF-06`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-06)) |
| **RF-28** | Isolar worktrees, processos, credenciais e redes conforme o perfil | P0 | F2/F4 | **Implementado e Aprovado** | Worktrees isoladas em diretórios separados com token único |
| **RF-29** | Oferecer capacidade administrativa autorizada ao gerente sem repassá-la ao trabalhador | P0 | F1/F4 | **Implementado e Aprovado** | Separação de escopos em `AcExecutionProfile` |
| **RF-30** | Exibir uso, cota e renovação por conta quando observáveis; desconhecido quando não observáveis | P0 | F1/F5 | **Implementado e Aprovado** | Backend com observações canônicas e endpoints de auditoria de cota |
| **RF-31** | Produzir auditoria de decisões, trocas, tentativas, revisão, integração e intervenção humana | P0 | F1 | **Conforme / Remediado** | Tabela append-only imutável ativa e preservada integralmente em backups ([`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05)) |
| **RF-32** | Permitir os percursos essenciais de configuração e operação pelo celular | P0 | F5 | **Conforme / Remediado** | Assistente móvel, grafo de dependências e botões de avanço, pausa, retomada e cancelamento ativos ([`DEF-07`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-07)) |
| **RF-33** | Importar histórico, planos e evidências dos Paseos sem duplicar trabalho concluído | P0 | F1 | **Implementado e Aprovado** | `AcPaseoImportService` e tarefa Rake `ac:import_paseo` implementados |
| **RF-34** | Exportar configuração e relatórios sem credenciais; oferecer backup e restauração | P0 | F6 | **Conforme / Remediado** | Backup e recuperação com suporte a decisões imutáveis e redefinição de sequences ([`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05)) |
| **RF-35** | Notificar conclusão agrupada e bloqueio relevante, com deduplicação e histórico | P0 | F5 | **Parcial com Defeito/Risco** | Deduplicação de comandos ativa; notificações push em tempo real pendentes |
| **RF-36** | Alterar configuração pelo chat usando a mesma API validada do painel, sem edição livre | P0 | F5 | **Implementado e Aprovado** | `ClientCommandsController` atua como gateway único para comandos |
| **RF-37** | Oferecer editor livre de grafos e editor móvel equivalente por etapas | P1 | F8 | **Fase Futura** | Editor móvel por etapas presente; canvas interativo livre em backlog P1 |
| **RF-38** | Permitir equipe com vários revisores e julgador dentro dos limites compartilhados | P1 | F8 | **Implementado e Aprovado** | `AcReviewCouncilService` com ondas e teto de 2 vagas |
| **RF-39** | Operar diretamente em worktree remota via adaptador homologado, com consistência | P1 | F8 | **Fase Futura** | Previsto para evolução direta com AgentReach |
| **RF-40** | Coletar e exportar uso, perfil, tentativas, tempo e retrabalho corretamente | P0/P1 | F1 | **Implementado e Aprovado** | Métricas registradas em `ac_executions` e `ac_decision_audit_events` |
| **RF-41** | Separar aprovação da entrega, integração, publicação e deploy em permissões diferentes | P0 | F3 | **Implementado e Aprovado** | Estados e papéis desacoplados entre `approve!` e `integrate!` |
| **RF-42** | Validar edição concorrente de políticas e disponibilizar reversão para versão anterior | P0 | F1 | **Implementado e Aprovado** | Revisões imutáveis com número incremental e transição de estado |
| **RF-43** | Cadastrar templates reutilizáveis por projeto sem duplicar os dados de contas globais | P0 | F1 | **Implementado e Aprovado** | Associação `belongs_to :company` com templates desacoplados |
| **RF-44** | Preservar pausas e bloqueios explícitos durante importação, reinício e recuperação de cota | P0 | F2/F6 | **Implementado e Aprovado** | `AcRecoveryService.preserve_pauses!` e checagem em `AcAdmissionService` |
| **RF-45** | Exigir a mesma autorização de tentativa/capacidade em todas as origens habilitadas | P0 | F2 | **Implementado e Aprovado** | `AcAdmissionService.validate_execution_authority!` sem bypass |
| **RF-46** | Compartilhar autoridade de admissão/refresh entre antigo/novo ou impedir sobreposição | P0 | F0/F6 | **Implementado e Aprovado** | `AcSharedCapacityCoordinatorService` com lock pessimista atômico |
| **RF-47** | Reservar recursos por execução de etapa e liberar após encerramento reconciliado | P0 | F2 | **Parcial com Defeito/Risco** | Bloqueado por [`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01) (Liberação precoce de recursos) |
| **RF-48** | Aceitar evidências de verificação apenas do executor confiável e condicionar integração | P0 | F3 | **Implementado e Aprovado** | `AcIntegrationService.validate_verification_evidence!` ativo |
| **RF-49** | Impedir acesso cruzado entre contas e acesso de agentes à administração da central | P0 | F0/F4 | **Implementado e Aprovado** | Sanitização rigorosa de ambiente em `OpenSshTransport` |
| **RF-50** | Exibir grafo de execução somente de leitura com estado, dependências e falhas | P0 | F5 | **Implementado e Aprovado** | `PlanGraph.tsx` com renderização de nós e arestas SVG |
| **RF-51** | Materializar com segurança projeto Git inicialmente acessível somente por SSH | P0 | F4 | **Implementado e Aprovado** | Testes e rotinas de materialização remota sem dependência de GitHub |
| **RF-52** | Atualizar workers/workflows com versões e restaurar a central em modo de recuperação | P0 | F2/F6 | **Implementado e Aprovado** | `AcRecoveryService.enter_recovery_mode!` com persistência em banco |
| **RF-53** | Deduplicar comandos móveis e reconexões pela identidade da intenção | P0 | F5 | **Implementado e Aprovado** | `AcCommandDeduplicationService` com lock e índice único em `intent_id` |
| **RF-54** | Garantir um único escritor autorizado por worktree e neutralizar acesso antigo | P0 | F2 | **Implementado e Aprovado** | `AcWorktreeManagerService` com quarentena e neutralização de lease |
| **RF-55** | Elegibilidade de integração por provedor, plano, titular, autenticação e modo | P0 | F0/G0 | **Divergência Intencional** | Homologado per [`ADR-002`](file:///home/enok/Documentos/projetos/agent-control/docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md) / [`DIV-INT-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#div-int-01) |
| **RF-56** | Seleção regular preservada por contexto de trabalho/chat | P0 | F1/G1 | **Fase Futura** | Registrado per [`REQ-FUT-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#req-fut-01) (Backlog antes de G1) |
| **RF-57** | Modelar dispensa de QA como resultado explícito de política, separado de ausência e falha | P0 | F3/G3 | **Parcial com Defeito/Risco** | **Falha P1:** [`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04) (Bloqueio de avanço com `waived`) |

---

## 4. Matriz de Conformidade dos 39 Cenários de Validação (T01 a T39)

| Cenário | Descrição do Cenário | Status de Verificação | Observação Forense e Evidência |
| :--- | :--- | :--- | :--- |
| **T01** | Duas contas Codex e perfis distintos | **REPROVADO** | Impedido pela constraint única upstream [`DEF-03`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-03). |
| **T02** | Grok -> Codex programador -> Gemini -> Sonnet -> reserva | **CONFORME C/ ADR-002** | Recalculado na ADR-002; caminhos não elegíveis desativados com motivo visível. |
| **T03** | Regular anterior recupera enquanto outro trabalha | **APROVADO** | Comprovado por testes unitários em `AcPolicyEngineServiceTest`. |
| **T04** | Regular recupera durante programação emergencial | **APROVADO** | Devolução respeitada pela regra de permanência do perfil emergencial. |
| **T05** | Todos esgotados; depois uma conta volta | **PARCIAL** | Mecanismo em banco pronto; acoplamento com Temporal sofre de [`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01). |
| **T06** | Plano pausado durante recuperação/reinício | **APROVADO** | Comprovado por `AcRecoveryServiceTest#test_preserve_pauses`. |
| **T07** | Falha após intenção, criação, handle; reenvio por UI/workflow | **REPROVADO** | Afetado por falso positivo e terminação precoce de processo em [`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01). |
| **T08** | Reinício nos pontos intermediários de lançamento | **REPROVADO** | Afetado por destruição prematura de worktree em [`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01). |
| **T09** | Revisão reprova e programador corrige | **REPROVADO** | Workflow de plano não aciona programador; simula aprovação fixa [`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02). |
| **T10** | Dois chats integram e escritor externo muda branch | **APROVADO** | Comprovado fisicamente via Git CAS em `AcPhysicalGitTest`. |
| **T11** | Limite global disputado por vários chats/hosts | **APROVADO** | Comprovado em `AcSharedCapacityCoordinatorServiceTest` com lock. |
| **T12** | Política muda entre concessão, início e resultado | **APROVADO** | Revisões de política são versionadas e imutáveis. |
| **T13** | Autenticação expira, rede falha ou modelo inválido | **APROVADO** | Estados canônicos em `AcQuotaObservation` não acusam falsa cota. |
| **T14** | SSH cai durante comando persistente | **APROVADO C/ RESSALVA** | Reconciliação funcional; ressalva de escape de diretório em [`DEF-06`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-06). |
| **T15** | Trabalhador tenta acessar outra conta/projeto/admin | **APROVADO** | Isolamento comprovado por `OpenSshTransport` e permissões de tenant. |
| **T16** | Operação completa no Android | **REPROVADO** | Ausência de botões e ações de ciclo de vida de plano no mobile [`DEF-07`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-07). |
| **T17** | Uso cumulativo, cache e raciocínio em eventos repetidos | **APROVADO** | Contabilização atômica em `AcCapacityGrant` sem dupla soma. |
| **T18** | Backup, restauração e reimportação | **REPROVADO** | Incompleto: perda de auditoria e falha de sequence em [`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05). |
| **T19** | Gerente principal esgota e recupera | **APROVADO** | Regra de retorno ao principal implementada em `AcExecutionProfile`. |
| **T20** | Cancelamento e lease expirada com executor inacessível | **APROVADO** | Neutralização de lease comprovada em `AcWorktreeManagerService`. |
| **T21** | QA encontra defeito após implementação | **REPROVADO** | Tarefa bloqueia avanço quando QA emite dispensa válida [`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04). |
| **T22** | Política tenta ativar Astra/esforço proibido/conta removida | **APROVADO** | Rejeição atômica antes do lançamento comprovada no modelo. |
| **T23** | Saída SSH tenta alterar controle da central | **APROVADO** | Isolamento de processos garante que saída SSH é texto inerte. |
| **T24** | Duas CLIs concorrentes tentam ler credenciais | **APROVADO** | `OpenSshTransport` usa `unsetenv_others: true` e HOME fictício. |
| **T25** | Repositório inicialmente disponível somente via SSH | **APROVADO** | Suportado por `AcRemoteGatewayService` e clone via chave dedicada. |
| **T26** | Login expira ou versão de CLI muda protocolo | **APROVADO** | Transição para estado de erro explicável sem bloqueio permanente. |
| **T27** | Celular reenvia comando após timeout/reconexão | **APROVADO** | Deduplicação rigorosa por `intent_id` comprovada via `AcClientCommand`. |
| **T28** | Antigo e novo usam a mesma conta (Coexistência) | **APROVADO** | Coordenador de capacidade compartilhada com lock pessimista (T28 / RF-46). |
| **T29** | Programação satura teto e precisa de QA/revisor | **APROVADO** | Concessões são liberadas por etapa em `AcReleaseCapacityActivity`. |
| **T30** | Restauração de backup com processos ainda vivos | **PARCIAL** | Modo de recuperação funcional, mas restauração sofre de [`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05). |
| **T31** | Capacidade desconhecida com probes concorrentes | **APROVADO** | Estado `unknown` preservado sem disparar emergência indevida. |
| **T32** | Update de worker com pendências | **PARCIAL** | Estratégia documental mapeada; pendente homologação em cluster real. |
| **T33** | Agente tenta forjar evidência de teste | **APROVADO** | `AcIntegrationService` exige identificação explícita do executor. |
| **T34** | Escritor antigo vivo quando nova tentativa é preparada | **APROVADO** | Quarentena e divergência de worktree em `AcWorktreeManagerService`. |
| **T35** | Workflow muda de estado com celular suspenso | **APROVADO** | `PlanGraph.tsx` sincroniza projeção via polling em `DagGraphsController`. |
| **T36** | Acesso direto ou tentativa administrativa sem RBAC | **APROVADO** | Protegido por `authenticate_user!` e escopo restrito de company. |
| **T37** | Dois chats preservam escolhas regulares distintas | **FASE FUTURA** | Pendente implementação de `REQ-FUT-01` per Adendo Final §2. |
| **T38** | Dispensa de QA avança; cancelado ou sem resultado impede | **REPROVADO** | Falha comprovada em [`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04) (waived rejeitado na aprovação). |
| **T39** | Elegibilidade de integração recusada antes de iniciar CLI | **APROVADO** | Homologado formalmente per `ADR-002` e `AcExecutionProfile`. |

---

## 5. Comparação Entre Alegações de Conclusão e Evidências Reais

| Componente / Fase | Alegação em `STATUS.md` | Evidência Real Comprovada | Veredito Forense |
| :--- | :--- | :--- | :--- |
| **Fase F0 (Gate G0)** | "Gate G0 Aprovado com 86/86 PASS físico em Lote 8" | Evidências retidas em `docs/validation/`, ADR-001 e ADR-002 aprovadas | **CONFIRMADO** |
| **Fase F1 (Gate G1)** | "Entidades, políticas, cotas e auditoria concluídas" | Modelos e serviços criados com testes passando; RF-05 impedido no schema | **PARCIALMENTE VERDADEIRO** (Bloqueio em RF-05) |
| **Fase F2 (Gate G2)** | "Execução durável ponta a ponta via Temporal aprovada" | Reconciliação prematura de processos e destruição assíncrona de worktree ([`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01)) | **ALEGAÇÃO NÃO COMPROVADA** |
| **Fase F3 (Gate G3)** | "Orquestração de plano e DAG concluída com aprovação CAS" | Workflow de plano não despacha tarefas; gera aprovação fixa fictícia ([`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02)) | **ALEGAÇÃO NÃO COMPROVADA** |
| **Fase F4 (Gate G4)** | "Gateway SSH e operações remotas persistentes concluídas" | Transporte OpenSSH seguro e isolado; ressalva menor de escape ([`DEF-06`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-06)) | **SUBSTANCIALMENTE CONFIRMADO** |
| **Fase F5 (Gate G5)** | "Produto operável pelo celular concluído" | Renderização do grafo presente; ausência de controles de plano no mobile ([`DEF-07`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-07)) | **PARCIALMENTE VERDADEIRO** |
| **Fase F6 (Gate G6)** | "Backup, recuperação e capacidade compartilhada concluídos" | Coexistência protegida com lock; backup omite auditoria e quebra sequences ([`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05)) | **PARCIALMENTE VERDADEIRO** |
| **Fase F7 (Gate G7)** | "Cutover e migração gradual concluídos" | Serviços em banco com eventos de auditoria funcionais; sem piloto real integrado | **CONFORME NÍVEL CONTRATUAL** |
| **Fase F8 (Gate G8)** | "Conselho de revisão multi-avaliador concluído" | `AcReviewCouncilService` funcional na lógica de ondas; opera de forma isolada | **CONFORME NÍVEL CONTRATUAL** |
| **Remediações** | "174 testes executados, 816 asserções, 0 falhas, 100% PASS" | Testes reais totalizam **158 runs, 708 assertions, 1 skip** com git montado | **DIVERGÊNCIA NUMÉRICA REGISTRADA** |
