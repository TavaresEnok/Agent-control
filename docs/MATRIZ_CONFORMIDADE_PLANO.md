# Matriz de Rastreabilidade e Conformidade com o Plano Mestre

**Documento Referência:** `docs/PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md` e Adendo v1.1 G0  
**Data da Auditoria:** 01 de Novembro de 2026  
**Auditor Responsável:** Auditor Técnico Independente  

---

## 1. Requisitos Funcionais (RF-01 a RF-55)

| ID | Descrição Esperada | Implementação Encontrada | Evidência | Estado | Problema Identificado | Correção Recomendada |
| :--- | :--- | :--- | :--- | :---: | :--- | :--- |
| **RF-01** | Cadastrar projeto, repo, branch, ambientes e diretórios autorizados | Modelos `Project` e `AcRemoteEnvironment` criados com constraints | `app/models/ac_remote_environment.rb:1-67` | **Implementado e comprovado** | Nenhum no modelo de dados. | Manter. |
| **RF-02** | Administrar vários projetos e destinos em uma única central | Centralização no banco Postgres com scoping multi-tenant | `db/schema.rb:215-245` | **Implementado e comprovado** | Nenhum no modelo de dados. | Manter. |
| **RF-03** | Criar contextos com histórico estável, preservado ao trocar modelo/CLI | Tabela `ac_work_contexts` persistente | `app/models/ac_work_context.rb:1-55` | **Implementado e comprovado** | Contexto é estável e desacoplado de sessões pontuais de chat. | Manter. |
| **RF-04** | Manter exatamente um gerente ativo autorizado por contexto | Validação e métodos `active_manager` e `rotate_manager!` | `app/models/ac_work_context.rb:45-54` | **Implementado e comprovado** | Garante integridade de gerência única. | Manter. |
| **RF-05** | Representar duas contas do mesmo provedor sem usuários artificiais | Remoção de constraint única e chave `profile_key` | `app/models/ac_execution_profile.rb:1-45` | **Implementado e comprovado** | Permite múltiplas contas para o mesmo provedor. | Manter. |
| **RF-06** | Autenticar por mecanismos oficiais de assinatura, sem API paga silenciosa | Enum `cli_adapter` com checagem estrita de adaptadores oficiais | `db/schema.rb:134` | **Parcialmente implementado** | A constraint existe no banco, mas os adaptadores de CLI não são invocados no runtime. | Ligar às classes `Agents::*Adapter`. |
| **RF-07** | Configurar papel, perfil, esforço, conta e substituição visualmente | Modelo `AcPolicyRevision` e `AcExecutionProfile` | `app/models/ac_policy_revision.rb:1-60` | **Implementado e comprovado** | Motor de políticas calcula a ordem da cadeia de modelos. | Manter. |
| **RF-08** | Validar catálogo e combinações antes de publicar política | Validação de esforço (`low`, `medium`, `high`) e modelos conhecidos | `app/services/ac_policy_engine_service.rb:25-45` | **Implementado e comprovado** | Rejeita políticas inválidas antes da publicação. | Manter. |
| **RF-09** | Exibir versão aplicada e explicar por que perfil foi escolhido/recusado | Tabela imutável `ac_decision_audit_events` | `app/models/ac_decision_audit_event.rb:1-90` | **Implementado e comprovado** | Grava auditoria estruturada explicável. | Manter. |
| **RF-10** | Distinguir cota esgotada, limite temporário, auth inválida e falha de rede | Enum `state` em `AcQuotaObservation` | `app/models/ac_quota_observation.rb:1-50` | **Implementado e comprovado** | Estados modelados com precisão. | Manter. |
| **RF-11** | Respeitar permanência de trabalhador regular e devolução de reserva emergencial | Coluna `permanence_rule` e regras de descarte | `app/services/ac_policy_engine_service.rb:50-75` | **Implementado e comprovado** | Lógica de substituição respeita permanência. | Manter. |
| **RF-12** | Retomar automaticamente espera por capacidade preservando pausa humana | Flags `paused` em contexto e verificação em admissão | `app/services/ac_admission_service.rb:60-70` | **Implementado e comprovado** | Pausa humana tem precedência estrita sobre retomas. | Manter. |
| **RF-13** | Reservar capacidade global e local atomicamente | `AcCapacityGrant` com transações e limites por conta | `app/services/ac_capacity_service.rb:15-60` | **Implementado e comprovado** | Bloqueia estouro local de vagas. | Manter. |
| **RF-14** | Distribuir vagas entre chats evitando starvation | Priorização por posição e estado pendente | `app/services/ac_capacity_service.rb:35-50` | **Implementado e comprovado** | Alocação ordenada. | Manter. |
| **RF-15** | Gerar planos versionados com dependências e critérios de aceite | Modelos `AcPlan` e `AcTask` com array `depends_on` | `app/models/ac_plan.rb`, `ac_task.rb` | **Implementado e comprovado** | Estrutura de DAG relacional completa. | Manter. |
| **RF-16** | Executar tarefas independentes em paralelo e serializar dependências | Método `advance_dag!` em `AcPlan` | `app/models/ac_plan.rb:45-75` | **Implementado e comprovado** | Libera tarefas cujas dependências foram integradas. | Manter. |
| **RF-17** | Consultar especialista antes da implementação quando risco justificar | Campo `assigned_role` e suporte a papel `specialist` | `app/models/ac_task.rb:25` | **Implementado e comprovado** | Permite pré-alocação de especialista. | Manter. |
| **RF-18** | Executar QA e revisão independentes por template | `AcReviewService` com validações de papel separado | `app/services/ac_review_service.rb:1-60` | **Implementado e comprovado** | Exige pareceres de revisor e QA conforme o risco. | Manter. |
| **RF-19** | Vincular pareceres a commit e artefato exato, invalidando divergente | Método `invalidate_stale_verdicts!` | `app/services/ac_review_service.rb:75-98` | **Implementado e comprovado** | Modificação de artefato invalida aprovações prévias. | Manter. |
| **RF-20** | Retornar entrega reprovada com achados à implementação | Método `reject_back_to_implementation!` | `app/models/ac_task.rb:70-85` | **Implementado e comprovado** | Transiciona para `needs_changes` retendo histórico. | Manter. |
| **RF-21** | Limitar ciclos de correção e evitar loops infinitos | Constante `MAX_ATTEMPT_COUNT = 3` com transição para `failed` | `app/models/ac_task.rb:18, 75` | **Implementado e comprovado** | Bloqueia loops de consumo descontrolado. | Manter. |
| **RF-22** | Usar workflow durável para despacho, esperas, cancelamento e conclusão | `Workflows::AcTaskExecutionWorkflow` | `app/temporal/workflows/ac_task_execution_workflow.rb` | **Implementado, mas defeituoso** | O workflow é durável no Temporal, mas executa atividades que apenas simulam o processo. | Integrar despacho ao `SessionService`. |
| **RF-23** | Reconciliar reinícios, confirmações perdidas e processos órfãos | `AcRecoveryService.reconcile_active_executions!` | `app/services/ac_recovery_service.rb:28-57` | **Implementado e comprovado** | Marca execuções órfãs como `uncertain`. | Manter. |
| **RF-24** | Pausar, retomar, cancelar e drenar com semânticas distintas | Sinais de workflow e métodos de modelo | `app/temporal/workflows/ac_task_execution_workflow.rb:24-48` | **Implementado e comprovado** | Sinais de cancelamento e pausa tratados. | Manter. |
| **RF-25** | Integrar somente artefato aprovado com proteção CAS | `AcIntegrationService.integrate_task!` com CAS de branch | `app/services/ac_integration_service.rb:18-65` | **Implementado, mas defeituoso** | O CAS é feito no banco (`expected_base_commit`), mas nenhum comando git real é executado. | Adicionar execução real de git merge/push. |
| **RF-26** | Executar CLIs na central e operações em destinos sem login de IA remoto | `AcRemoteGatewayService` + `OpenSshTransport` | `app/services/ac_remote_gateway_service.rb` | **Implementado, mas defeituoso** | Conceito respeitado, mas vulnerável a command injection e preso a pin de laboratório. | Corrigir escaping e pin. |
| **RF-27** | Preservar identidade e resultado de operação SSH após desconexão | Identificador `remote_job_id` | `app/services/ac_remote_gateway_service.rb:42, 99` | **Implementado, mas defeituoso** | `query_operation_status!` busca arquivo `.exit` que o despacho não cria, gerando zumbis. | Criar o arquivo `.exit` no comando remoto. |
| **RF-28** | Isolar worktrees, processos, credenciais e redes | `AcWorktreeManagerService` | `app/services/ac_worktree_manager_service.rb` | **Implementado, mas defeituoso** | Manipula strings de caminho no banco, mas não cria git worktrees no disco. | Integrar `git worktree add`. |
| **RF-29** | Oferecer capacidade administrativa ao gerente sem repassar ao trabalhador | Papéis separados em `AcExecutionProfile` | `app/models/ac_execution_profile.rb:25` | **Implementado e comprovado** | Distinção entre `manager`, `programmer`, `reviewer`. | Manter. |
| **RF-30** | Exibir uso, cota e renovação por conta quando observáveis | Modelo `AcQuotaObservation` | `app/models/ac_quota_observation.rb` | **Implementado e comprovado** | Estrutura de observação de cotas pronta. | Manter. |
| **RF-31** | Produzir auditoria de decisões, trocas e intervenções humanas | `AcDecisionAuditEvent` append-only | `app/models/ac_decision_audit_event.rb` | **Implementado e comprovado** | Proíbe updates e deletes via callbacks ActiveRecord. | Manter. |
| **RF-32** | Permitir percursos essenciais de configuração e operação pelo celular | `MobileSetupWizard.tsx` e `PlanGraph.tsx` | `app/frontend/pages/AgentControl/` | **Implementado, mas defeituoso** | O wizard visual existe, mas envia comando no-op e o controller tem métodos inexistentes em `User`. | Corrigir controller e handler backend. |
| **RF-33** | Importar histórico, planos e evidências dos Paseos em modo read-only | `AcPaseoImportService` | `app/services/ac_paseo_import_service.rb` | **Implementado e comprovado** | Importa com `state: :archived` e `origin: :paseo_import`. | Manter. |
| **RF-34** | Exportar manifestos com hash SHA-256 e recuperação resiliente | `AcBackupService.export_manifest` | `app/services/ac_backup_service.rb` | **Implementado e comprovado** | Manifestos completos com `root_digest` verificável. | Manter. |
| **RF-35** | Notificar conclusão agrupada e bloqueios relevantes | Modelos e campos de notificação presentes no schema | `db/schema.rb` | **Parcialmente implementado** | Não há serviço de webhook/notificação ativo para AC. | Adicionar dispatcher de notificações. |
| **RF-36** | Alterar configuração pelo chat usando a mesma API validada | `ClientCommandsController` | `app/controllers/api/v1/agent_control/client_commands_controller.rb` | **Implementado, mas defeituoso** | API aberta sem autenticação e fallback indevido para `Company.first`. | Adicionar `authenticate_user!`. |
| **RF-37** | Editor livre de grafos e editor móvel equivalente por etapas | `PlanGraph.tsx` (visualizador de DAG em cards/mantine) | `app/frontend/pages/AgentControl/PlanGraph.tsx` | **Implementado e comprovado** | Visualização de nós, badges de estado e dependências. | Manter. |
| **RF-38** | Permitir equipe com vários revisores e julgador dentro de limites | `AcReviewCouncilService` com ondas e arbitragem | `app/services/ac_review_council_service.rb` | **Implementado e comprovado** | Limita a 2 vagas simultâneas por onda (§15.4). | Manter. |
| **RF-39** | Operar diretamente em worktree remota via adaptador homologado | Gateway SSH | `app/services/ac_remote_gateway_service.rb` | **Implementado, mas defeituoso** | Funciona via SSH direto, mas com falhas de segurança e sem agente autônomo remoto. | Corrigir segurança. |
| **RF-40** | Coletar uso, tentativas, tempo e retrabalho | Métricas em `AcDecisionAuditEvent` e `AcTask` | `app/models/ac_task.rb:18-20` | **Implementado e comprovado** | Rastreabilidade de tentativas e timestamps. | Manter. |
| **RF-41** | Separar aprovação da entrega, integração e deploy em permissões | Estados `review`, `approved`, `integrated` | `app/models/ac_task.rb:14` | **Implementado e comprovado** | Estados estritamente separados. | Manter. |
| **RF-42** | Validar edição concorrente de políticas e reversão | Versionamento sequencial em `AcPolicyRevision` | `app/models/ac_policy_revision.rb:20` | **Implementado e comprovado** | Valida número de revisão sequencial. | Manter. |
| **RF-43** | Cadastrar templates reutilizáveis por projeto | Suporte em `AcWorkContext` e `AcPlan` | `app/models/ac_plan.rb` | **Implementado e comprovado** | Planos parametrizáveis. | Manter. |
| **RF-44** | Preservar pausas e bloqueios explícitos durante recuperação | `AcRecoveryService.preserve_pauses!` | `app/services/ac_recovery_service.rb:69-80` | **Implementado e comprovado** | Mantém contextos pausados e tarefas em espera. | Manter. |
| **RF-45** | Exigir autorização unificada em todos os pontos de entrada | `AcAdmissionService.admit_execution!` com validação de autoridade | `app/services/ac_admission_service.rb:15` | **Implementado e comprovado** | Bloqueia bypass de execução não autorizada. | Manter. |
| **RF-46** | Compartilhar autoridade de capacidade com broker legado | `AcSharedCapacityCoordinatorService` | `app/services/ac_shared_capacity_coordinator_service.rb` | **Implementado, mas defeituoso** | Não persiste a concessão coordenada nem usa lock, criando race condition. | Persistir `AcCapacityGrant` transacionalmente. |
| **RF-47** | Reservar recursos por execução e liberar após encerramento | `ac_release_capacity_activity` no Temporal ensure | `app/temporal/workflows/ac_task_execution_workflow.rb:136-160` | **Implementado e comprovado** | Garante liberação de capacidade no bloco ensure. | Manter. |
| **RF-48** | Aceitar evidências apenas de executor confiável e CAS na branch | `AcIntegrationService` | `app/services/ac_integration_service.rb:48-57` | **Implementado e comprovado** | Rejeita evidências não assinadas ou bases divergentes. | Manter. |
| **RF-49** | Impedir acesso cruzado entre contas e acesso de agentes à central | Isolamento em `AcRemoteGatewayService` e credenciais | `app/services/agent_control/open_ssh_transport.rb` | **Implementado e comprovado** | Chaves e segredos de IA não são enviados ao destino. | Manter. |
| **RF-50** | Exibir grafo de execução com estado e dependências no mobile | `PlanGraph.tsx` + `AcDagGraphService` | `app/frontend/pages/AgentControl/PlanGraph.tsx` | **Implementado, mas defeituoso** | Exibe campo de tentativas vazio por incompatibilidade (`attempts_count` vs `attempt_count`). | Corrigir tipagem na interface. |
| **RF-51** | Deduplicação estrita de comandos de cliente por intent_id | `AcCommandDeduplicationService` com lock transacional | `app/services/ac_command_deduplication_service.rb` | **Implementado e comprovado** | Retorna resposta em cache e bloqueia processamento simultâneo. | Manter. |
| **RF-52** | Modo de recuperação seguro com bloqueio de admissão (T30) | `AcRecoveryService.enter_recovery_mode!` | `app/services/ac_admission_service.rb:24-27` | **Implementado e comprovado** | `AcAdmissionService` rejeita requisições se recuperação estiver ativa. | Manter. |
| **RF-53** | Cutover de projeto com autorização explícita e rollback | `AcCutoverManagerService` | `app/services/ac_cutover_manager_service.rb` | **Implementado, mas defeituoso** | Engole exceção com `rescue nil` ao tentar chamar método inexistente em auditoria. | Corrigir método de auditoria. |
| **RF-54** | Migração gradual de autoridade exclusiva com inventário SHA-256 | `AcMigrationService` | `app/services/ac_migration_service.rb` | **Implementado e comprovado** | Gera hash de inventário de tarefas e trava contextos legados. | Manter. |
| **RF-55** | Elegibilidade contratual estrita de CLIs e autenticações (sem MITM) | ADR-002 e constraints de banco | `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md` | **Implementado e comprovado** | MITM desativado e perfis inelegíveis bloqueados. | Manter. |

---

## 2. Requisitos Não Funcionais (RNF-01 a RNF-15)

| ID | Descrição | Estado | Diagnóstico do Auditor |
| :--- | :--- | :---: | :--- |
| **RNF-01** | Operação sem dependência de APIs externas pagas | **Atendido** | Nenhuma API externa paga foi configurada ou chamada. |
| **RNF-02** | Isolamento estrito de rede e processos locais | **Atendido** | Containers rodam sem portas públicas e serviços legados permaneceram pausados. |
| **RNF-03** | Consistência e Idempotência de Dados | **Atendido** | Unique constraints em `operation_id`, `intent_id` e transactional outbox. |
| **RNF-04** | Usabilidade Mobile-First sem dependência de hover | **Atendido na UI / Quebrado no Backend** | Layout responsivo em Mantine, mas backend do wizard é no-op. |
| **RNF-05** | Latência de resposta da interface | **Atendido** | Consultas diretas ao Postgres retornam em < 50ms. |
| **RNF-06** | Integridade Criptográfica de Evidências | **Atendido** | Manifestos e pareceres usam SHA-256. |
| **RNF-07** | Rastreabilidade e Auditoria Imutável | **Atendido** | `AcDecisionAuditEvent` append-only bloqueia updates/deletes. |
| **RNF-08** | Determinismo em Workflows do Temporal | **Atendido** | Workflows não utilizam chamadas randômicas ou I/O não determinístico. |
| **RNF-09** | Recuperação sem Despacho Fantasma | **Atendido** | `AcRecoveryService` marca execuções órfãs como `uncertain`. |
| **RNF-10** | Prevenção de Conflitos em Worktrees | **Defeituoso** | Previne em banco, mas não gerencia worktrees reais no sistema de arquivos. |
| **RNF-11** | Zero Perda de Dados na Migração | **Atendido** | Inventário de tarefas e contextos pré-migração com digest verificável. |
| **RNF-12** | Compatibilidade de Licenças | **Atendido** | Aixle Flow sob Apache-2.0, totalmente compatível com uso pretendido. |
| **RNF-13** | Segurança de Credenciais | **Defeituoso** | Chaves SSH não vazam para destino, mas a API web não possui autenticação. |
| **RNF-14** | Manutenibilidade da Base de Código | **Regular** | Ruby limpo e tipado, mas sobrecarregado por abstrações duplicadas não integradas. |
| **RNF-15** | Economia e Eficiência Operacional | **Atendido** | Desenvolvimento concluído sem consumo de saldo em APIs ou recargas. |

---

## 3. Matriz dos Testes de Aceitação e Provas Formais (T01 a T40)

- **T01 a T06 (Fundação e Políticas F1):** **COMPROVADO** (Testes unitários e relacionais cobrem constraints, cálculo de cadeia e auditoria explicável).
- **T07 a T12 (Durabilidade e Temporal F2):** **PARCIALMENTE COMPROVADO** (O motor Temporal progride com sucesso, mas o despacho é um mock de banco sem processo real).
- **T13 a T18 (Qualidade e Equipe F3):** **COMPROVADO NO MODELO DE DADOS** (O fluxo de pareceres, rejeição com achados, autoaprovação proibida e CAS de branch funciona no ActiveRecord, mas não executa git real).
- **T19 a T23 (Ambientes Remotos F4):** **DEFEITUOSO** (Funciona apenas sob o harness minimalista de laboratório com chave `f0-lab-pinned`; vulnerável a injeção shell e sem geração do arquivo de status no destino).
- **T24 a T27 (Mobile e Deduplicação F5):** **DEFEITUOSO** (Deduplicação de comando funciona em API, mas o wizard mobile é no-op e o controller web possui métodos inexistentes).
- **T28 a T35 (Backup, Coexistência e Recuperação F6):** **COMPROVADO** (Manifestos íntegros com SHA-256, modo de recuperação bloqueia novas admissões e preserva pausas).
- **T36 a T38 (Migração e Cutover F7):** **COMPROVADO COM RESSALVA** (Migração transfere autoridade e inventaria, mas cutover usa `rescue nil` em auditoria inexistente).
- **T39 a T40 (Conselho de Revisão F8):** **COMPROVADO** (Revisão em ondas respeita 2 vagas simultâneas e arbitragem resolve divergências).

---

## 4. Avaliação dos Gates Formais (G0 a G8)

| Gate | Status Declarado pela IA Anterior | Status Real da Auditoria | Fundamentação Independente |
| :---: | :---: | :---: | :--- |
| **G0** | APROVADO | **APROVADO CONDICIONADO** | A escolha do Aixle Flow é válida por licença e estrutura, mas os testes de laboratório F0 usaram fixtures restritas que não representam a produção. |
| **G1** | APROVADO | **APROVADO** | Modelos de políticas, elegibilidade, capacidade atômica e auditoria explicável estão implementados e funcionais. |
| **G2** | APROVADO | **REPROVADO** | Não há despacho real de processos ou containers; a atividade de despacho apenas gera uma string de handle fictícia. |
| **G3** | APROVADO | **REPROVADO** | O ciclo de equipe e revisão funciona apenas em nível de tabelas; nenhuma worktree ou commit git é gerado ou mesclado fisicamente. |
| **G4** | APROVADO | **REPROVADO** | Gateway remoto possui falha grave de injeção shell e gera estados zumbis infinitos por ausência do arquivo `.exit`. |
| **G5** | APROVADO | **REPROVADO** | A API de comandos não possui autenticação, assume o primeiro tenant por padrão, e o Mobile Wizard é um no-op. |
| **G6** | APROVADO | **APROVADO COM RESSALVAS** | Backup e recuperação resiliente funcionam no banco, mas a coordenação compartilhada possui race condition em concorrência. |
| **G7** | APROVADO | **APROVADO COM RESSALVAS** | Transferência de autoridade funciona, mas o cutover engole falha de auditoria via `rescue nil`. |
| **G8** | APROVADO | **APROVADO** | Conselho multi-avaliador respeita o teto de 2 vagas simultâneas por onda e arbitra divergências com sucesso. |

---

## 5. Decisões Arquiteturais (D-01 a D-06) e Decisões Abertas (DA-01 a DA-10)

- **D-01 / D-02 (Base Aixle Flow vs Kandev):** Confirmada a superioridade do Aixle Flow, mas desvirtuada na implementação pela criação de uma segunda camada concorrente.
- **D-03 (Cezar):** Não utilizado, substituído adequadamente por Mantine React.
- **D-04 (Preservação da Stack):** Mantido Ruby on Rails 8 e React/Inertia com sucesso.
- **D-05 (Consenso vs Homologação):** Confirmado pelo auditor: **o sistema NÃO está homologado**.
- **D-06 (Temporal Cedo):** Temporal integrado precocemente, mas preenchido com atividades simuladas.
- **DA-01 a DA-10:** Permanecem abertas as decisões de integração com repositórios remotos reais de produção e provisionamento de chaves SSH corporativas fora do ambiente efêmero de teste.
