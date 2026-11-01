# ARQUITETURA RECOMENDADA FINAL
## Consolidação, Desacoplamento e Sustentabilidade da Plataforma Agent Control

**Data:** 2026-11-01  
**Autor:** Arquiteto Principal de Software e Auditor de Sistemas Distribuídos  
**Contexto:** Diagnóstico da implementação atual do Agent Control sobre a base Aixle Flow.

---

## 1. Avaliação Crítica da Escolha de Base e Alternativas Estruturais

A auditoria identificou um dilema central no estado atual do repositório:
- **A Promessa do Aixle Flow (ADR-001):** Uma plataforma corporativa completa em Ruby on Rails + Temporal com múltiplos modelos, gerenciamento de credenciais, runners de containers e interface Mantine.
- **A Realidade do Código Construído:** A IA desenvolvedora não utilizou o motor nativo do Aixle Flow. Em vez disso, construiu uma aplicação paralela (`Ac*`) com seus próprios modelos, workflows e tabelas. Como resultado, o projeto carrega **todo o peso do Aixle Flow** (dezenas de migrações legadas de marketplace, Stripe, Azure DevOps, Bitbucket, Kubernetes, mais de 40 workflows do Temporal) **sem usufruir de seus recursos de execução de agentes**.

### 1.1 Análise de Caminhos Estruturais

| Abordagem | Descrição | Prós | Contras | Recomendação |
|---|---|---|---|:---:|
| **Opção A: Manter como está (Remendar Camada Paralela)** | Corrigir a segurança e injetar execução de subprocessos dentro da camada `Ac*`, mantendo a base Aixle Flow intocada ao fundo. | Menor esforço imediato de reescrita; preserva os 141 testes unitários existentes. | Carrega centenas de tabelas e workflows mortos; duplica conceitos no banco; manutenção complexa para um único operador. | **Não Recomendada** |
| **Opção B: Unificação Profunda com o Upstream Aixle Flow** | Reescrever o subsistema `Ac*` para usar nativamente os conceitos do Aixle Flow (`Workflow`, `WorkflowStep`, `Session`, `ContainerStrategies`). | Reaproveita código testado do upstream e telas nativas do Aixle Flow. | Extremamente invasivo; acopla o Agent Control a um modelo de containers complexo voltado para SaaS multi-tenant que não atende aos requisitos específicos do Plano Mestre v1.1. | **Não Recomendada** |
| **Opção C: Consolidação em Núcleo Enxuto (Lean Agent Control)** | **(RECOMENDADA)** Preservar o stack Ruby on Rails + Temporal, consolidar o domínio `Ac*` como o núcleo oficial do sistema, podar o código legado do Aixle Flow que não agrega valor e conectar o núcleo a CLIs locais reais e Git físico. | Mantém o trabalho sólido de modelagem do domínio (contextos, planos, tarefas, DAG, capacidade atômica, auditoria append-only); elimina o peso morto do upstream; foca em CLIs oficiais e Git real. | Exige limpeza e consolidação de tabelas legadas. | **RECOMENDADA** |

---

## 2. Visão Lógica da Arquitetura Alvo Recomendada

A arquitetura recomendada adota o modelo de **Quatro Camadas Especializadas com Autoridade Única**, eliminando simulações e integrando processos reais:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   1. CAMADA DE PRODUTO & CONTROLE                      │
│   Web / PWA (Inertia + React)  │  Mobile Wizard  │  API Segura (JWT)   │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Intent ID Deduplicado
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│            2. CAMADA DE POLÍTICA, ADMISSÃO E CAPACIDADE                │
│   AcAdmissionService (Ponto Único)  │  AcCapacityGrant (SELECT FOR UP)  │
│   AcPolicyEngineService (Explicável)│  AcQuotaObservation (Evidências) │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Concessão Atômica + Época
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│             3. CAMADA DE ORQUESTRAÇÃO DURÁVEL (TEMPORAL)                │
│   AcPlanExecutionWorkflow (DAG)   │  AcRemoteOperationWorkflow (SSH)   │
│   AcTaskExecutionWorkflow (Worker)│  Sinais: Pause / Resume / Cancel   │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Atividades com Efeitos Reais
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 4. CAMADA DE RUNTIME FÍSICO E RECURSOS                 │
│  Git Engine Real (Worktrees/CAS)  │  CLI Adapters (Codex/Claude/Grok)  │
│  OpenSSH Gateway (Persistente)   │  Audit Trail Imutável (PostgreSQL)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Especificação das Responsabilidades e Contratos

### 3.1 Camada 1: Produto, Autenticação e Deduplicação
- **Autenticação Obrigatória:** Todos os endpoints sob `/api/v1/agent_control/` exigem sessão ativa ou token assinado via HMAC com a chave da instância.
- **Multi-Tenancy Estrito:** A empresa é resolvida a partir do usuário autenticado (`current_user.company`). Fim de qualquer fallback para `Company.first`.
- **Deduplicação de Intenção:** Todo comando de cliente (Web, Mobile, CLI) trafega com um `intent_id` único, processado transacionalmente por `AcCommandDeduplicationService`.

### 3.2 Camada 2: Admissão, Cotas e Capacidade
- **Ponto Único de Entrada:** Nenhuma execução de agente é disparada sem passar por `AcAdmissionService.admit_execution!`.
- **Concessão Atômica com Época:** Alocação de slots via `SELECT FOR UPDATE` em `AcCapacityGrant`, associando a tentativa a um identificador de época incremental (`epoch`).
- **Reserva e Liberação Garantida:** A capacidade é reservada antes de iniciar o processo e liberada incondicionalmente no bloco `ensure` do workflow Temporal após reconciliação terminada.

### 3.3 Camada 3: Orquestrador Durável Temporal
- **Workflow de Plano (`AcPlanExecutionWorkflow`):**
  - Avalia o DAG em rodadas;
  - Despacha tarefas prontas lançando instâncias filhas de `AcTaskExecutionWorkflow` (paralelismo real);
  - Coordena o fluxo de revisão independente e bloqueio por retrabalho (`needs_changes`);
  - Encerra quando todas as folhas do DAG são integradas.
- **Workflow de Tarefa (`AcTaskExecutionWorkflow`):**
  - Executa as 5 atividades fundamentais com efeitos colaterais reais:
    1. `AcAdmitTaskActivity`: Reserva atômica de capacidade;
    2. `AcAcquireWorktreeActivity`: Executa `git worktree add` físico;
    3. `AcDispatchExecutionActivity`: Lança a CLI do agente em subprocesso supervisionado;
    4. `AcReconcileExecutionActivity`: Captura o diff, commit, logs reais e status de saída;
    5. `AcReleaseCapacityActivity`: Neutraliza a lease e remove a worktree temporária (`git worktree remove`).

### 3.4 Camada 4: Runtime Físico e Executores
- **Isolamento de Worktree Git:**
  - Diretório padrão: `var/worktrees/task_<id>_<epoch>`;
  - Branch isolada: `ac/task-<id>-attempt-<epoch>`;
  - Cada trabalhador atua estritamente em sua cópia local.
- **Execução Real das CLIs Oficiais:**
  - Execução via `Open3.popen3` passando variáveis de ambiente isoladas (`HOME` específico da conta, redigindo chaves administrativas);
  - Suporte às CLIs homologadas na ADR-002: **OpenAI Codex CLI**, **Anthropic Claude Code CLI** e **xAI Grok CLI**;
  - Captura streaming de eventos de token e stdout para cálculo de custos.
- **Integração Condicional Protegida (CAS):**
  - `git update-ref refs/heads/<branch> <candidate_sha> <expected_base_sha>`;
  - Se a branch foi modificada externamente durante a implementação, rejeita a integração com erro atômico e exige reconciliação pelo DAG.

---

## 4. Estratégia de Transição e Limpeza (Migração Segura)

Para transformar o repositório atual na arquitetura recomendada sem perder o trabalho valioso já construído:

1. **Passo 1 — Preservar a Fundação de Domínio:**  
   Manter as migrações e modelos `AcWorkContext`, `AcPlan`, `AcTask`, `AcExecution`, `AcCapacityGrant`, `AcPolicyRevision`, `AcExecutionProfile`, `AcQuotaObservation` e `AcDecisionAuditEvent`. Essa modelagem relacional é robusta, bem normalizada e atende com fidelidade aos requisitos do Plano Mestre v1.1.
2. **Passo 2 — Substituir as Simulações pelas Operações Reais:**  
   Refatorar os serviços `AcWorktreeManagerService` e `AcIntegrationService` para invocar comandos Git reais, e a atividade `AcDispatchExecutionActivity` para invocar as CLIs reais instaladas no host.
3. **Passo 3 — Corrigir as Brechas de Segurança na API:**  
   Adicionar autenticação e isolamento multi-tenant no controller do Agent Control.
4. **Passo 4 — Podar o Upstream Não Utilizado:**  
   Gradualmente desativar rotas, tabelas e workflows legados do Aixle Flow que não possuem relação com o Agent Control (como marketplace de templates, billing Stripe, webhooks de Azure/Bitbucket), reduzindo a sobrecarga operacional do banco e do Temporal.
5. **Passo 5 — Conectar o Frontend Real:**  
   Conectar o formulário móvel (`MobileSetupWizard.tsx`) à criação efetiva de projetos e contextos, e adicionar tela de acompanhamento e configuração de modelos.
