# EVIDÊNCIAS COLETADAS E LIMITAÇÕES DA AUDITORIA
## Registro Técnico de Comandos, Inspeções e Fronteiras de Verificação

**Data da Auditoria:** 2026-11-01  
**Autor:** Auditoria Técnica Independente de Arquitetura e Segurança  
**Ambiente:** Host Linux (`/home/enok/Documentos/projetos/agent-control`)  

---

## 1. Inventário de Inspeções e Comandos Executados

Durante a realização desta auditoria forense, foram executadas inspeções estáticas, verificações de repositório Git e execuções não destrutivas de testes automatizados:

### 1.1 Inspeção de Repositório e Histórico Git
- **Comando:** `git log --reverse --oneline`  
  **Objetivo:** Reconstrução cronológica de todas as entregas desde a importação do Aixle Flow (`2d696ab`) até a entrega final (`5ecece7`).
- **Comando:** `git diff --stat 2d696ab..HEAD`  
  **Objetivo:** Inventário quantitativo de modificações: 529 arquivos adicionados/modificados, 45.191 inserções e 98 deleções.
- **Comando:** `git diff --name-status --diff-filter=M 2d696ab..HEAD`  
  **Objetivo:** Mapeamento exato de quais arquivos do upstream Aixle Flow foram modificados (apenas 7 arquivos de código da aplicação).

### 1.2 Inspeção Estática de Código e Vulnerabilidades
- **Arquivos Inspecionados a Fundo:**
  - `app/controllers/api/v1/agent_control/application_controller.rb`: Descoberta da ausência total de autenticação e fallback permissivo para `Company.first`.
  - `app/controllers/api/v1/agent_control/client_commands_controller.rb`: Descoberta de comandos não tratados (`setup_project_wizard` descartado no `else`).
  - `app/services/ac_remote_gateway_service.rb`: Descoberta do despacho síncrono e ausência de geração de arquivos de supervisão (`.exit`).
  - `app/temporal/activities/agent_control/ac_dispatch_execution_activity.rb`: Descoberta de handles aleatórios sintéticos sem subprocessos.
  - `app/temporal/workflows/ac_plan_execution_workflow.rb`: Descoberta do condicional específico de teste `trigger_review_for_task_id`.
  - `app/services/ac_worktree_manager_service.rb` e `ac_integration_service.rb`: Descoberta de ausência de comandos Git físicos.
  - `app/services/ac_recovery_service.rb`: Descoberta de restauração sem ingestão de dados e modo de recuperação em memória volátil.
  - `app/services/ac_cutover_manager_service.rb`: Descoberta de método inexistente `record_decision!` mascarado com `rescue nil`.
  - `app/frontend/pages/AgentControl/MobileSetupWizard.tsx`: Descoberta de interface placebo sem persistência real.

### 1.3 Execução Isolada de Testes Automatizados
- **Comando Executado:**
  ```bash
  docker run --net=host --security-opt seccomp=unconfined --rm \
    -v "$(pwd):/work" -w /work -e SKIP_COVERAGE=1 -e PARALLEL_WORKERS=1 \
    -e RAILS_ENV=test -e DB_HOST=127.0.0.1 -e DB_PORT=5432 \
    -e DB_USERNAME=postgres -e DB_PASSWORD=postgres -e DB_NAME=aixle_test \
    agent-control-f0-rails-deps:4.0.9 bin/rails test \
    test/models/ac_*.rb test/services/ac_*.rb \
    test/controllers/api/v1/agent_control/*.rb \
    test/temporal/workflows/ac_*.rb \
    test/services/agent_control/open_ssh_transport_test.rb
  ```
- **Resultado Físico Observado:**
  - **Duração:** 22,12 segundos
  - **Estatísticas:** 141 runs, 657 asserções, 0 falhas, 0 erros, 1 skip.
  - **Skip Identificado:** `test/services/agent_control/open_ssh_transport_test.rb` (pulado devido à ausência do cliente `ssh` dentro da imagem Docker de dependências).

---

## 2. Materiais Ausentes e Limitações da Auditoria

Em estrita conformidade com as regras de auditoria ("não faça alterações no código ou infraestrutura", "não consuma cotas ou APIs pagas", "diferencie defeitos comprovados de hipóteses"), foram observadas as seguintes fronteiras:

### 2.1 Preservação dos Ambientes Pausados
- O serviço `paseo-flow.service` permaneceu **completamente parado e intocado**.
- Os projetos legados (`Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat`) permaneceram **pausados e intactos**.
- Nenhuma tentativa de cutover ou migração real contra as bases em produção foi realizada. Isso impediu verificar o comportamento de lock concorrente com instâncias vivas do Paseo em execução contínua. Essa verificação é classificada como **comportamento não verificável sem ativação do legado**.

### 2.2 Preservação Orçamentária e Ausência de Inferência Paga
- Não foram disparadas chamadas de inferência de longa duração que consumissem saldo da assinatura OpenAI, Anthropic ou xAI.
- As CLIs instaladas no host (`codex 0.164.0`, `claude 2.1.310`, `grok 1.0.70`, `agy 1.4.12`) foram inspecionadas localmente via sistema de arquivos e versões, mas **não foram submetidas a loops contínuos de coding autônomo** durante a auditoria para preservar o teto orçamentário estabelecido pelo proprietário (~$10).

### 2.3 Simulação nos Testes Existentes
- A suíte de testes unitários existente utiliza mocks e fixtures para simular respostas de rede e da Temporal. Portanto, o resultado de 100% de aprovação (141 testes) reflete apenas a coerência dos testes com seus próprios mocks, e **não comprova o funcionamento da orquestração com agentes e repositórios reais**.

---

## 3. Classificação Epistemológica das Descobertas

| Descoberta | Categoria de Conhecimento | Fonte da Evidência |
|---|---|---|
| Falta de autenticação e fallback `Company.first` na API | **Defeito Comprovado** | Inspeção estática direta no código-fonte |
| Invocação de método inexistente com `rescue nil` em cutover | **Defeito Comprovado** | Inspeção estática direta no código-fonte |
| Despacho Temporal gera string e não lança subprocesso/CLI | **Defeito Comprovado** | Inspeção estática direta no código-fonte |
| Workflow de plano condicionado a flag de teste | **Defeito Comprovado** | Inspeção estática direta no código-fonte |
| Falta de comandos Git físicos em worktrees e CAS | **Defeito Comprovado** | Inspeção estática direta no código-fonte |
| Restauração pós-desastre não insere registros no banco | **Defeito Comprovado** | Inspeção estática direta no código-fonte |
| Assistente móvel não processa comando no backend | **Defeito Comprovado** | Inspeção estática direta no código-fonte |
| Comportamento sob concorrência de refresh com Paseo ativo | **Não Verificável** | Paseos intencionalmente pausados |
| Consumo real de tokens e latência sob carga contínua de IA | **Não Verificável** | Orçamento preservado sem inferência paga |
