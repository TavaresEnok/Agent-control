# F0-CHECKLIST — Critérios obrigatórios do Gate G0

**Data:** 2026-10-31  
**Escopo:** Fase F0 (validação estrutural e comparativa antes de fork/implementação)  
**Fontes normativas:**
- `docs/PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md` (Plano v1.1)
- `docs/ADENDO_FINAL_PLANO_v1.1_G0_2026-10-31.md` (Adendo Final — prevalece em caso de divergência)

---

## 1. Regras de avaliação do G0

- **Sem aprovação por presunção:** nenhum critério obrigatório pode ser considerado aprovado sem evidência registrada (`docs/README.md` L23; Plano v1.1 §19.1, §20.4).
- **Execução vs. documentação:** quando o critério exige prova de execução, inspeção documental ou de código sozinha não satisfaz o gate (Plano v1.1 §3.1, §26.4; instruções F0).
- **Comparação obrigatória de custo:** comparar explicitamente Kandev e Aixle Flow nas mesmas fronteiras, mesmo quando um ou ambos se mostrarem viáveis ou exigirem adaptação (Plano v1.1 §1.4, §3.4, §19.3, §27.2 C01; Adendo §1, §7).
- **Elegibilidade contratual/oficial (RF-55):** funcionamento técnico (login ou inferência) não comprova permissão de uso do plano/transporte; cada caminho deve ser classificado antes de chamadas reais (Adendo §4.1–4.3).
- **Capacidade compartilhada na F0 (RF-46 / extensão T28):** proibida qualquer chamada real com contas compartilhadas sem autoridade única de admissão e renovação coordenada com os Paseos ativos, ou contas explicitamente não sobrepostas e autorizadas (Adendo §5).

---

## 2. Checklist dos critérios eliminatórios e condições do G0

| ID | Critério obrigatório | Origem normativa | Tipo de evidência exigida | Estado atual na F0 | Referência em `F0-EVIDENCIAS.md` |
|---|---|---|---|---|---|
| **G0-E1** | Executar as CLIs necessárias (`codex`, `claude`, `grok`, `agy`/Antigravity) com as assinaturas corretas, sem substituição silenciosa por API paga, distinguindo os dois perfis Antigravity (Gemini e Sonnet) | Plano v1.1 §3.4 item 1, §19.3 Pacote B, §20.2 T01/T02 | Código + verificação de elegibilidade (RF-55) + execução real controlada nas CLIs/perfis elegíveis | **IMPEDIDO / PENDENTE** (binários `codex`, `claude`, `grok`, `agy_acp_server.par` ausentes no host; Antigravity consumidor encapsulado `unsupported_for_mode`; sem autorização/coordenação para chamadas reais) | EV-01, EV-02, EV-04, EV-05 |
| **G0-E2** | Executar simultaneamente duas contas independentes do mesmo provedor (ex.: duas contas Codex), com identidade verificável e leitura cruzada de credenciais bloqueada tecnicamente (`HOME` distinto sozinho não basta) | Plano v1.1 §3.4 item 2, §13.2, §19.3 Pacote B, §20.2 T01/T24, §27.2 C03 | Prova de execução com segredos sintéticos (fronteira OS) + prova integrada na base com duas contas reais | **PARCIAL** (fronteira OS provada por execução sintética; **código de ambas as bases reprova nativamente** sem adaptação; prova real não executada) | EV-04, EV-05, EV-06 |
| **G0-E3** | Identificar todos os pontos de entrada e demonstrar, numa fatia mínima, autoridade única (Temporal) de admissão, lançamento, retomada, cancelamento e reconciliação após falha entre intenção/processo/handle | Plano v1.1 §3.4 item 3, §10.2.1, §11.3.1, §19.3 Pacote A/C, §20.2 T07/T08, §27.2 C02 | Inventário completo de código + execução de fatia mínima Temporal na base | **PARCIAL** (inventário estático concluído em ambas as bases; Kandev não possui Temporal; binário/servidor Temporal ausente no host para execução da fatia) | EV-01, EV-03, EV-04, EV-05 |
| **G0-E4** | Preservar isolamento real e proteger UI, API, WebSocket, terminal e MCP sem caminho direto de contorno; validar com credenciais sintéticas antes de logins reais | Plano v1.1 §3.4 item 4, §17.2, §17.4, §19.3 Pacote B, §20.2 T15/T23/T36, §27.2 C04 | Auditoria de código/configuração + prova sintética de bloqueio antes de credenciais reais | **COMPROVADO POR CÓDIGO (LACUNA NAS BASES) + PROVA SINTÉTICA** (Kandev tem auth opt-in desabilitada por padrão, bind `0.0.0.0` e MCP externo sem auth; Aixle usa proxy MITM no container) | EV-04, EV-05, EV-06 |
| **G0-E5** | Demonstrar percurso útil no celular (1 perfil + 1 tarefa, reconexão/reenvio deduplicado, visão de etapas/grafo), sem depender de desktop conectado | Plano v1.1 §3.4 item 5, §16.2.1, §16.5, §19.3 Pacote D, §20.2 T16/T27/T35, §27.2 C11/C12 | Auditoria de superfície + execução de percurso móvel na base escolhida | **PARCIAL** (superfície auditada em código/docs; percurso integrado na base pendente de runtime/Temporal e credenciais elegíveis) | EV-04, EV-05 |
| **G0-E6** | Ter licença e estratégia de distribuição compatíveis com o uso aprovado (operação pessoal central e manutenção de fork privado) | Plano v1.1 §3.4 item 6, §19.3 Pacote A, §22.3, §26.2 | Inspeção dos arquivos `LICENSE` nos commits fixados | **COMPROVADO POR CÓDIGO/DOCUMENTAÇÃO** (Kandev: `AGPL-3.0`; Aixle Flow: `Apache-2.0`) | EV-02, EV-04, EV-05 |
| **G0-E7** | Demonstrar operação Git/teste via SSH com fingerprint verificado, materializando repositório inicialmente acessível apenas pelo destino, com IA autenticada somente na central | Plano v1.1 §3.4 item 7, §14.2.1, §19.3 Pacote E, §20.2 T25, §27.2 C05 | Auditoria do executor SSH das bases + prova de execução SSH isolada | **PARCIAL** (fronteira SSH provada por execução em `sshd` efêmero local com chave fixada e sem vazamento de segredo; ainda pendente em destino remoto dedicado da base escolhida) | EV-04, EV-05, EV-07 |
| **G0-AD1** | Verificar e classificar a elegibilidade contratual/oficial de cada método de integração, plano, CLI e transporte (`RF-55` / `T39`) antes de chamadas reais | Adendo §4.1, §4.2, §4.3, §6 (`RF-55` / `T39`) | Fontes primárias + inspeção dos adaptadores de Kandev e Aixle Flow | **COMPROVADO POR CÓDIGO/DOCUMENTAÇÃO** (matriz RF-55 concluída; Antigravity consumidor encapsulado e MITM/intermediação classificados como `unsupported_for_mode`) | EV-03, EV-04, EV-05 |
| **G0-AD2** | Respeitar capacidade e renovação compartilhadas desde a F0 caso haja ensaio com contas reais em uso pelo Paseo ativo (`RF-46` / extensão `T28`) | Adendo §5, §6; Plano v1.1 §21.5 | Preservação operacional + verificação de não execução de chamadas concorrentes | **COMPROVADO POR EXECUÇÃO/PROCEDIMENTO** (nenhuma conta real, serviço ativo, fila ou Paseo foi tocado nesta F0) | EV-01 |
| **G0-COMP** | Comparar custo de adaptação entre Kandev e Aixle Flow com pesos da seção 3.4 e recomendar a base em `ADR-001` | Plano v1.1 §3.4, §19.3, §27.2 C01; Adendo §1, §7 | Matriz comparativa fundamentada no código inspecionado nos commits fixados | **CONCLUÍDO** (documentado em `ADR-001-BASE-DA-PLATAFORMA.md`) | EV-02, EV-04, EV-05 |

---

## 3. Síntese de verificação do Gate G0

- **Critérios integralmente satisfeitos nesta etapa:** `G0-E6`, `G0-AD1`, `G0-AD2`, `G0-COMP`.
- **Critérios com prova técnica parcial (estática + prova sintética/local concluída, faltando prova integrada na base escolhida):** `G0-E2`, `G0-E3`, `G0-E4`, `G0-E5`, `G0-E7`.
- **Critérios bloqueados por pré-requisitos externos/decisão do proprietário:** `G0-E1` (ausência das CLIs no host, inelegibilidade contratual do Antigravity consumidor encapsulado e restrição de uso de contas reais compartilhadas sem coordenação prévia).
- **Decisão resultante para o Gate G0:** **PENDENTE** (proibido declarar aprovado enquanto houver critério obrigatório de execução pendente).
