# Inventário de Evidências, Inspeções e Limitações da Auditoria

**Data:** 01 de Novembro de 2026  
**Auditor:** Arquiteto Principal de Software & Auditor Técnico Independente  
**Ambiente de Auditoria:** Host Linux (`x86_64`), Docker Engine, Postgres 16 em container local (`ac-test-pg`), Ruby 4.0.0 / Rails 8.1.4  

---

## 1. Inventário de Comandos e Inspeções Realizadas

A presente auditoria não se baseou em hipóteses teóricas. Todos os achados foram comprovados através de comandos determinísticos executados diretamente no ambiente de trabalho:

### 1.1 Inspeções de Código e Estrutura Git
- `git log -n 15 --oneline`: Rastreamento da árvore de commits desde a importação do Aixle Flow (`2d696ab`) até o commit atual (`5ecece7`);
- `git diff --stat 2d696ab HEAD`: Levantamento do volume de modificações (529 arquivos modificados, 45.191 adições, 98 deleções);
- `find . -name "*ac_*" -o -name "*agent_control*"`: Identificação exata de todos os modelos, controllers, serviços e workflows criados pelo Agent Control;
- `grep -rn "codex_cli" app/`: Comprovação de que as CLIs não possuem classes de adapter no domínio `ac_*`;
- `grep -rn "prompt" app/services/ac_*`: Comprovação de que nenhum prompt de IA é montado ou enviado aos agentes pela camada de tarefas do AC;
- `grep -rn "Agents::" app/services/ac_*`: Comprovação de que a camada `ac_*` nunca instancia os adaptadores existentes do Aixle Flow.

### 1.2 Inspeções de Segurança e Contratos de Rede
- Leitura de [`config/routes.rb`](file:///home/enok/Documentos/projetos/agent-control/config/routes.rb) e [`config/routes/web.rb`](file:///home/enok/Documentos/projetos/agent-control/config/routes/web.rb) mapeando as rotas `/api/v1/agent_control/*` e `/agent_control/*`;
- Análise de [`app/controllers/api/v1/agent_control/application_controller.rb`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/api/v1/agent_control/application_controller.rb), revelando a ausência de autenticação e o fallback indevido para `Company.first`;
- Análise de [`app/services/ac_remote_gateway_service.rb`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb) e [`app/services/agent_control/open_ssh_transport.rb`](file:///home/enok/Documentos/projetos/agent-control/app/services/agent_control/open_ssh_transport.rb), constatando interpolação insegura de comandos e dependência de pin fixo de teste (`f0-lab-pinned`).

### 1.3 Execuções e Testes Físicos no Container
A suíte de testes do Agent Control foi executada isoladamente dentro do container Docker oficial de dependências (`agent-control-f0-rails-deps:4.0.9`) conectado ao banco Postgres local:
```bash
docker run --net=host --security-opt seccomp=unconfined --rm -v "$(pwd):/work" -w /work \
  -e SKIP_COVERAGE=1 -e PARALLEL_WORKERS=1 -e RAILS_ENV=test -e DB_HOST=127.0.0.1 \
  -e DB_PORT=5432 -e DB_USERNAME=postgres -e DB_PASSWORD=postgres -e DB_NAME=aixle_test \
  agent-control-f0-rails-deps:4.0.9 bin/rails test test/models/ac_*_test.rb test/services/ac_*_test.rb \
  test/services/agent_control/open_ssh_transport_test.rb test/controllers/api/v1/agent_control/*_test.rb \
  test/temporal/workflows/ac_*_test.rb
```
**Resultado Físico:**
```text
Finished in 24.203768s, 5.8255 runs/s, 27.1445 assertions/s.
141 runs, 657 assertions, 0 failures, 0 errors, 1 skips
```
**Análise Crítica do Resultado:** Embora a suíte apresente 100% de sucesso, a auditoria confirmou que todos os 141 testes exercitam exclusivamente as regras relacionais do ActiveRecord e o determinismo básico do Temporal. NENHUM teste valida a chamada real de uma CLI de IA, nenhum teste cria uma worktree no disco e nenhum teste valida a rejeição de requisições desautenticadas na API.

---

## 2. Materiais e Fontes Examinadas

1. **Repositório `agent-control`:** Árvore completa de código em `/home/enok/Documentos/projetos/agent-control`;
2. **Plano Mestre v1.1:** `docs/PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md` (1433 linhas, 27 seções);
3. **Adendo Final G0:** `docs/ADENDO_FINAL_PLANO_v1.1_G0_2026-10-31.md`;
4. **Decisões Arquiteturais Registradas:** `docs/ADR-001-BASE-DA-PLATAFORMA.md` e `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md`;
5. **Relatórios da IA Anterior:** `docs/STATUS.md` e relatórios de evidências em `docs/F0-EVIDENCIAS.md`.

---

## 3. Materiais Indisponíveis e Limitações do Parecer

Em conformidade com a regra de que o auditor não deve inventar dados ou simular verificações, registram-se as seguintes limitações fáticas do ambiente:
1. **Credenciais Reais de IA e Chaves de Produção:**
   - O ambiente não possuía (e nem deveria possuir, conforme restrições de segurança) chaves de API pagas ou credenciais corporativas reais do proprietário ativas durante os testes locais;
   - Essa limitação impediu testar o comportamento de faturamento em tempo real, mas não impediu auditar estaticamente o código dos adaptadores.
2. **Cluster Externo do Temporal:**
   - O Temporal foi executado através do harness embutido de teste (`Temporalio::Testing::WorkflowEnvironment`), que comprova a semântica do workflow mas não testa latências de rede sob clustering distribuído multi-node.
3. **Servidores Remotos Reais de Produção:**
   - As provas de SSH foram limitadas ao laboratório efêmero de loopback local. A conectividade e políticas de firewall de eventuais servidores remotos de produção futuros permanecem dependentes de homologação em campo na Fase C4.

---

## 4. Declaração de Integridade do Auditor

O auditor declara que:
- Não possui vínculo com as decisões tomadas pela IA desenvolvedora anterior;
- Não realizou alterações estruturais no código durante a elaboração deste parecer;
- Todos os defeitos apontados possuem comprovação direta no código-fonte através de caminhos de arquivos e números de linha auditáveis;
- A conclusão expressa neste dossiê representa o julgamento técnico independente mais rigoroso e protetor do interesse do proprietário da plataforma.
