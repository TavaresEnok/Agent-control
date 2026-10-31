# STATUS — Agent Control

**Última atualização:** 2026-10-31  
**Fase atual:** **F0 concluída (análise estática, matriz de elegibilidade e provas locais sintéticas/SSH)** — aguardando revisão do proprietário e deliberação sobre o **Gate G0 (`PENDENTE`)**.  
**Próxima fase prevista:** Fechamento das provas de execução dependentes de autorização/CLIs no G0 ou início da F1 (somente após aprovação explícita do proprietário).

---

## 1. Entregas da F0 produzidas

| Arquivo | Estado | Resumo |
|---|---|---|
| `docs/F0-CHECKLIST.md` | Concluído | Checklist rastreável dos critérios obrigatórios de F0/G0 com origem no Plano v1.1 e no Adendo Final. |
| `docs/F0-EVIDENCIAS.md` | Concluído | Registro de `EV-01` a `EV-07` separando o que foi comprovado por execução, comprovado por código/documentação e impedimentos. |
| `docs/ADR-001-BASE-DA-PLATAFORMA.md` | Concluído | Comparação técnica e de custo de adaptação entre Kandev (`997bc54f`) e Aixle Flow (`e6ec5a28`), recomendação pelo gatilho D-02 e declaração do G0 como **PENDENTE**. |
| `docs/STATUS.md` | Concluído | Este arquivo de estado para continuidade sem necessidade de reler o histórico do chat. |

---

## 2. Estado do ambiente e preservação operacional

- **Repositório Git local:** inicializado em `/home/enok/Documentos/projetos/agent-control` (`.gitignore` configurado para ignorar `.f0/`).
- **Snapshots dos candidatos clonados isoladamente em `.f0/candidates/`:**
  - Kandev: `997bc54fae4da15702c91da5c5d120bfe651edc1` (`main`, `AGPL-3.0`)
  - Aixle Flow: `e6ec5a286120aed3a036d85871e796b2f6c97d70` (`develop`, `Apache-2.0`)
- **Preservação dos sistemas existentes:**
  - Nenhuma instância ativa do Paseo, banco de dados, fila, projeto (`Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat`) ou serviço existente foi tocado, reiniciado ou reconfigurado.
  - Nenhuma credencial real foi lida, copiada ou versionada.
  - Nenhuma chamada paga de IA ou login em provedor foi executada.

---

## 3. Resumo das decisões e pendências para o proprietário

1. **Recomendação da ADR-001:** adotar **Aixle Flow (`e6ec5a28`)** pelo gatilho da condição de reversão **D-02** do Plano v1.1 (pontuação ponderada **3,40 / 5,00** contra **2,25 / 5,00** do Kandev), pois já traz **Temporal, transactional outbox (`OutboxRelay`), admissão com lease (`SessionAdmissionService` / `SessionAdmissionReconciler`) e jobs SSH destacados (`CoderSshExec`)**, enquanto o Kandev não possui Temporal, espalha o lançamento por 9 pontos de entrada, vem com autenticação desabilitada por padrão e copia credenciais de IA para o host SSH.
2. **Situação do Gate G0:** **PENDENTE**.
   - **Já comprovado por execução local:** isolamento de credenciais via user/mount namespace (`unshare -Umr`) contra falha de simples troca de `HOME` (`EV-06`), e fluxo Git + teste via SSH com fingerprint fixado e sem envio de segredo de IA ao destino (`EV-07`).
   - **Pendente de decisão/autorização:**
     1. Escolha entre **Aixle Flow** (recomendado por D-02) e **Kandev** (D-01).
     2. Definição sobre a cadeia de modelos sem o **Antigravity consumidor encapsulado** (`unsupported_for_mode` conforme `RF-55` / Adendo §4.2) e verificação dos termos xAI para o **Grok CLI** (`not_assessed`).
     3. Autorização para instalar os binários ausentes (`temporal`, `codex`, `claude`, `grok`) em ambiente isolado e realizar a fatia mínima integrada na base escolhida respeitando a coordenação de capacidade compartilhada (`Adendo §5`).
