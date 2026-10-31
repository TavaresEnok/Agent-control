# F0-CHECKLIST — Critérios obrigatórios do Gate G0

**Data:** 2026-10-31
**Escopo:** Consolidação F0 e aprovação do Gate G0 no clone de desenvolvimento Aixle Flow (`e6ec5a286120aed3a036d85871e796b2f6c97d70`).
**Status do Gate G0:** **APROVADO (PASS)**. Transição para F1 autorizada.
**Fontes normativas:**
- `docs/PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md` (Plano v1.1)
- `docs/ADENDO_FINAL_PLANO_v1.1_G0_2026-10-31.md` (Adendo Final)
- `docs/ADR-001-BASE-DA-PLATAFORMA.md` (Adoção do Aixle Flow)
- `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md` (Recálculo da Cadeia de Modelos per RF-55 / T39)
- `docs/validation/F0-LOTE8.md` (Evidências físicas do Lote 8)

---

## 1. Regras de Avaliação do G0 (Verificação Concluída)

- **Sem aprovação por presunção:** Todos os critérios eliminatórios foram auditados com evidências físicas registradas em `docs/validation/artifacts/` e manifestos de SHA-256.
- **Execução vs. documentação:** O laboratório de acesso (E4) executou a matriz real com 86 asserções em contêineres e redes isoladas, sem mocks. O SSH (E7) foi comprovado fisicamente via OpenSSH e repositório isolado.
- **Comparação de custo:** Concluída per ADR-001 (Aixle Flow 3,40 vs Kandev 2,25).
- **Elegibilidade contratual/oficial (RF-55 / T39):** Recalculada na ADR-002. `agy` consumidor desativado na política de admissão com motivo visível. Codex CLI, Claude Code e Grok CLI confirmadas como `documented_supported`.
- **Capacidade compartilhada (RF-46 / T28):** Ensaios executados exclusivamente com identidades e fixtures sintéticas em ambiente estanque; serviços adjacentes preservados.

---

## 2. Checklist dos Critérios Eliminatórios e Condições do G0

| ID | Critério obrigatório | Origem normativa | Tipo de evidência exigida | Estado Conclusivo | Referência Documental |
|---|---|---|---|---|---|
| **G0-E1** | Executar CLIs necessárias com assinatura correta, sem API paga ou substituição silenciosa | Plano v1.1 §3.4 item 1, §19.3 B, T01/T02 | Elegibilidade por modo/plano + CLIs locais verificadas | **PASS**. Node 24, Codex 0.164.0, Claude 2.1.310, Grok 1.0.70 e Temporal 1.9.1 verificados localmente. Cadeia recalculada na ADR-002 | ADR-002, EV-30 |
| **G0-E2** | Duas contas simultâneas do mesmo provedor, identidade verificável e leitura cruzada bloqueada | Plano v1.1 §3.4 item 2, §13.2, §19.3 B, T01/T24, C03 | Fronteira sintética + isolamento multi-tenant real | **PASS**. Rejeição de vazamento cross-tenant e bloqueio de subscription de stream assinado confirmados no Lote 8 | EV-12, EV-30, F0-LOTE8 |
| **G0-E3** | Inventariar entradas e provar autoridade única de admissão/start/retomada/conclusão/cancel/reconciliação | Plano v1.1 §3.4 item 3, §10.2.1/11.3.1, §19.3 A/C, T07/T08, C02 | Código + costura física com Temporal | **PASS**. Prova de costura PG+relay+Temporal retida em EV-19 (AlreadyStarted, lease renovado, dedup, cleanup PASS) | EV-19 |
| **G0-E4** | Proteger UI/API/WS/terminal/MCP e impedir contorno direto antes de logins reais | Plano v1.1 §3.4 item 4, §17.2/17.4, §19.3 B, T15/T23/T36, C04 | Auditoria + negação em execução na base | **PASS FÍSICO COMPLETO**. Matriz Lote 8 em laboratório isolado: **86 PASS, 0 FAIL, 0 NOTRUN**. Cleanup PASS | EV-30, F0-LOTE8 |
| **G0-E5** | Percurso móvel com perfil/tarefa, reconexão/reenvio e etapas/grafo | Plano v1.1 §3.4 item 5, §16.2.1/16.5, §19.3 D, T16/T27/T35, C11/C12 | Percurso na base, efeito deduplicado e estado real | **PASS**. Pacote móvel versionado e conferido, componentes responsivos validados (EV-17) | EV-17 |
| **G0-E6** | Ter licença e estratégia de distribuição compatíveis com o uso aprovado | Plano v1.1 §3.4 item 6, §19.3 Pacote A, §22.3, §26.2 | Inspeção dos arquivos `LICENSE` nos commits fixados | **PASS**. Licença Apache-2.0 confirmada no upstream e clone | EV-02, ADR-001 |
| **G0-E7** | Git/teste SSH com fingerprint, repositório só no destino e IA central | Plano v1.1 §3.4 item 7, §14.2.1, §19.3 E, T25, C05 | SSH + integração do transporte escolhido | **PASS FÍSICO**. Pin negativo, repo apenas no destino, bundle/SHA/teste remoto, journal e cleanup PASS | EV-27 |
| **G0-AD1** | Elegibilidade por provedor/plano/titular/CLI/transporte antes do efeito | Adendo §4/6, RF-55/T39 | Fontes oficiais + bloqueio na admissão | **PASS**. `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md` publicada; desativação prévia do transporte não elegível | ADR-002, EV-30 |
| **G0-AD2** | Capacidade/refresh comuns desde a primeira chamada compartilhada | Adendo §5/6; Plano §21.5, RF-46/T28 | Coordenação real ou contas autorizadas não sobrepostas | **PASS**. Preservação ativa sem refresh concorrente; Paseo pausado mantido isolado | EV-11, EV-30 |
| **G0-COMP** | Comparar custo de adaptação entre Kandev e Aixle Flow com pesos da seção 3.4 e recomendar a base em `ADR-001` | Plano v1.1 §3.4, §19.3, §27.2 C01; Adendo §1, §7 | Matriz comparativa fundamentada no código inspecionado | **PASS**. Aixle Flow aprovado como base de trabalho | ADR-001 |

---

## 3. Conclusão Final do Gate G0

Todos os 10 itens eliminatórios e condições do Gate G0 foram executados, comprovados e documentados.
**Status Consolidado:** **GATE G0 APROVADO**.
O projeto Agent Control avança formalmente para a **Fase 1 (F1 — Fundação de Domínio e Workflows)**.
