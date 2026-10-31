# F0-CHECKLIST — Critérios obrigatórios do Gate G0

**Data:** 2026-10-31  
**Escopo:** consolidação F0 no clone de desenvolvimento Aixle; G0 **PENDENTE**, F1 não iniciada.
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
| **G0-E1** | Executar CLIs necessárias com assinatura correta, sem API paga ou substituição silenciosa | Plano v1.1 §3.4 item 1, §19.3 B, T01/T02 | Elegibilidade por modo/plano + CLI real | **NOT RUN** real. Codex é o único candidato da costura F0, condicionado ao modo/plano; perfis históricos não são fallback ativo. Binários de EV-01 são inventário histórico, não diagnóstico atual. Sem login real nesta continuação | EV-01/03/05 (histórico), EV-09/11 |
| **G0-E2** | Duas contas simultâneas do mesmo provedor, identidade verificável e leitura cruzada bloqueada | Plano v1.1 §3.4 item 2, §13.2, §19.3 B, T01/T24, C03 | Fronteira sintética + integração com contas reais | **PARCIAL sintético HOST; integrado NOT RUN**. EV-12: HOME vazou; namespace bloqueou cinco ataques em ambas as direções, leitura própria mantida. EV-09 negado preservado; não prova sandbox completo, duas identidades reais ou isolamento Aixle | EV-05/06/09 (histórico), EV-12 |
| **G0-E3** | Inventariar entradas e provar autoridade única de admissão/start/retomada/conclusão/cancel/reconciliação | Plano v1.1 §3.4 item 3, §10.2.1/11.3.1, §19.3 A/C, T07/T08, C02 | Código + fatia real na base | **PARCIAL; integração inicial FAIL**. HOST passou sintaxe11/unitários/preflight, mas nenhum cenário Temporal concluiu (`run_id:nil`). Correção usa `result_run_id`; runtime corrigido NOT RUN. Harness SQL de nove testes importa contratos reais, transporte/runtime simulados; execução PG e costura PG+Temporal reais pendentes. Sem prova global de autoridade/bypass | EV-04/05/08, EV-13/14 |
| **G0-E4** | Proteger UI/API/WS/terminal/MCP e impedir contorno direto antes de logins reais | Plano v1.1 §3.4 item 4, §17.2/17.4, §19.3 B, T15/T23/T36, C04 | Auditoria + negação em execução na base | **PARCIAL documental; T36 NOT RUN**. Auditoria de 18 arquivos fixos; ttyd sem auth própria implica bypass condicional se alcançável. MITM e acesso direto ainda exigem fechamento/prova. Guard standalone não protege lançamentos globais | EV-04/05/06, EV-09 |
| **G0-E5** | Percurso móvel com perfil/tarefa, reconexão/reenvio e etapas/grafo | Plano v1.1 §3.4 item 5, §16.2.1/16.5, §19.3 D, T16/T27/T35, C11/C12 | Percurso na base, efeito deduplicado e estado real | **PARCIAL sintético; integrado NOT RUN**. Quatro checks de componentes em Chromium emulado. Persona não é perfil conta/modelo; tarefa é fixture; dois payloads iguais não provam efeito único. Aparelho físico, shell autenticado e grafo Temporal não executados | EV-04/05, EV-10 |
| **G0-E6** | Ter licença e estratégia de distribuição compatíveis com o uso aprovado (operação pessoal central e manutenção de fork privado) | Plano v1.1 §3.4 item 6, §19.3 Pacote A, §22.3, §26.2 | Inspeção dos arquivos `LICENSE` nos commits fixados | **COMPROVADO POR CÓDIGO/DOCUMENTAÇÃO** (Kandev: `AGPL-3.0`; Aixle Flow: `Apache-2.0`) | EV-02, EV-04, EV-05 |
| **G0-E7** | Git/teste SSH com fingerprint, repositório só no destino e IA central | Plano v1.1 §3.4 item 7, §14.2.1, §19.3 E, T25, C05 | SSH + integração do transporte escolhido | **PARCIAL histórico; integração NOT RUN**. EV-07 prova loopback com segredo sintético; não prova destino dedicado nem adapter Aixle/OpenSSH, ou autenticação real central | EV-04/05/07, EV-11 |
| **G0-AD1** | Elegibilidade por provedor/plano/titular/CLI/transporte antes do efeito | Adendo §4/6, RF-55/T39 | Fontes + bloqueio no fluxo gerenciado | **PARCIAL documental/sintético**. 24 recusas antes do spy; positivo sintético. Modo Codex hospedado/remoto `requires_clarification`; T39 global Aixle **NOT RUN**. Matriz histórica não homologa credenciais/entitlements atuais | EV-03/04/05, EV-09 |
| **G0-AD2** | Capacidade/refresh comuns desde a primeira chamada compartilhada | Adendo §5/6; Plano §21.5, RF-46/T28 | Coordenação real ou contas autorizadas não sobrepostas | **PRESERVAÇÃO PROCEDIMENTAL**: ensaios sem contas reais; T28 real **NOT RUN**. Controlador ativo não prova admissão comum entre Paseo e Aixle | EV-01 (histórico), EV-08/09/10/11 |
| **G0-COMP** | Comparar custo de adaptação entre Kandev e Aixle Flow com pesos da seção 3.4 e recomendar a base em `ADR-001` | Plano v1.1 §3.4, §19.3, §27.2 C01; Adendo §1, §7 | Matriz comparativa fundamentada no código inspecionado nos commits fixados | **CONCLUÍDO** (documentado em `ADR-001-BASE-DA-PLATAFORMA.md`) | EV-02, EV-04, EV-05 |

---

## 3. Síntese de verificação do Gate G0

- **Concluídos documentalmente:** `G0-E6` e `G0-COMP`; comparação mantém notas estáticas, sem homologação operacional.
- **Parciais ou NOT RUN:** `G0-E1`–`G0-E5`, `G0-E7`, `G0-AD1`; `G0-AD2` respeitado por não usar contas, sem comprovar T28 integrado.
- Aixle candidato e instalação isolada já autorizados; laboratório Temporal pronto. Faltam execução da candidata revisada, PG descartável, costura real, fronteira integrada, elegibilidade e arranjo seguro de contas em etapa própria.
- **Decisão resultante para o Gate G0:** **PENDENTE** (proibido declarar aprovado enquanto houver critério obrigatório de execução pendente).

Estado vigente do lote 2, política exclusiva efetiva, comandos e critérios restantes:
[`validation/F0-LOTE2.md`](validation/F0-LOTE2.md), EV-12–15. EV-01–11 e
F0-RETOMADA preservam histórico; suas limitações antigas de ambiente e leitura
da exclusiva não são o estado vigente. Sem repetição de suítes nesta consolidação;
implementação documental concluída exige revisão independente posterior e não aprova gate.
