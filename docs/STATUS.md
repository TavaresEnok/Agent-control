# STATUS — Agent Control

**Atualização:** 2026-10-31. **Fase: F0 em fechamento de provas; G0 PENDENTE. F1 não iniciada.**
Aixle Flow `e6ec5a286120aed3a036d85871e796b2f6c97d70` é candidato aprovado
para desenvolvimento, sem homologação definitiva. A consolidação documental
está pronta para revisão independente; isso não conclui os eliminatórios.

## Continuidade e preservação

- Worktree exclusiva desta entrega: `/home/enok/srv_projetos/worktrees/14v3rrig/task-88f319957cc4-g0-lote3-status`; HEAD inicial `772dc68`, árvore inicial limpa. Clone identificado por `UPSTREAM.json`; lotes `e59f2072f8f4` e `a9c3be73bab4` DONE/quatro entregas e revisões independentes PASS cada, conforme contrato. Histórico em EV-12–15/[F0-LOTE2](validation/F0-LOTE2.md); atualização vigente em EV-16–18/[F0-LOTE3](validation/F0-LOTE3.md).
- Origem e entregas Zed em `/home/enok/Documentos/projetos/agent-control` preservadas, sem acesso ou cópia de produto à origem. Zed terminou conforme usuário; isso não comprova saúde de serviços.
- Controlador ativo para este fluxo conforme delegação e histórico das tarefas; não foi consultada saúde do serviço nem iniciado/reiniciado daemon. Aixle não recebeu autoridade sobre planos ativos.
- `Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat` e demais projetos permanecem pausados. Nenhum serviço, credencial real, API paga, produção, migração, deploy/push/merge ou commit nesta entrega.
- Contexto autocontido do contrato, documentos de referência, recibos versionados e commits das duas entregas fornecem a procedência desta consolidação; sem depender do transporte de `.paseo-context`. Somente documentação autorizada e metadado de resultado alterados.

## Matriz de continuidade G0

Esta síntese remete à matriz normativa completa em [F0-CHECKLIST](F0-CHECKLIST.md)
e às origens exatas em [F0-EVIDENCIAS](F0-EVIDENCIAS.md), EV-01–18.

| Critério | Estado e prova | Lacuna eliminatória / próxima evidência |
|---|---|---|
| E1 CLIs/assinaturas | NOT RUN real; EV-03/09 documental e guard sintético | Modo/plano/CLI/entitlement elegíveis e execução controlada em etapa própria |
| E2 duas contas/isolamento | Parcial sintético HOST: HOME vazou; namespaces bloquearam cinco ataques nas duas direções; EV-12 | Isolamento integrado Aixle e duas contas reais identificáveis continuam NOT RUN |
| E3 autoridade/durabilidade | Temporal inicial FAIL preservado; gerência executou correção revisada: cinco cenários reais PASS; PG real 9 testes/67 assertions/0skip, guard 2/16 e preflights PASS; EV-16 | Duas fatias isoladas. Costura PG + relay + Temporal implementada/revisada conforme contrato; execução física integrada PENDENTE, EV-18 |
| E4 UI/API/WS/terminal/MCP | Auditoria fixa; execução T36 NOT RUN; EV-09 | Laboratório de gateway/rede com testes negativos inclusive acesso direto; retirar MITM/CA/proxy e fechar bypass |
| E5 móvel | Execução parcial de componentes; novo pacote móvel retido e hashes conferidos, EV-17; transporte/dados sintéticos | Perfil conta/modelo, criação de tarefa, reenvio com efeito único, reconexão e estado/grafo reais no shell autenticado |
| E6 licença | Documental concluído; Apache-2.0, EV-02/05 | Preservar licença/avisos e estratégia privada no fork |
| E7 SSH | Execução histórica loopback/segredo sintético, EV-07 | Destino dedicado de teste e transporte Aixle/OpenSSH com hostkey, artefato/teste e IA central; NOT RUN integrado |
| AD1 RF-55/T39 | Documental + 24 recusas standalone, EV-09 | Codex hospedado/remoto requires_clarification; guard global na base NOT RUN |
| AD2 RF-46/T28 | Preservação sem contas reais, EV-11 | T28 real NOT RUN; autoridade comum ou contas explicitamente não sobrepostas antes de chamada |
| COMP | Comparação estática concluída, ADR-001/EV-02/04/05 | Notas 3,40 Aixle / 2,25 Kandev não anulam eliminatórios |

## Autorizações, política e próximo bloco

A escolha do candidato e instalação isolada já foram autorizadas. As pendências
antigas de nova autorização genérica estão encerradas; ambiente, elegibilidade,
contas em etapa própria e gates continuam exigidos. A política EFETIVA exclusiva
`project_role_policies` id `agent-control` cobre as raízes de origem e workspace:
manager `codex/gpt-6.1-sol high`; programmer/reviewer
`codex-programmer/gpt-6.1-sol medium`, em sessões independentes;
`automatic_fallback:false`, `quota_behavior:wait_for_same_account_positive_evidence`.
A cadeia global não substitui essa regra. Fonte: contrato do controlador, sem
inspeção de configuração do host pelo executor; detalhes em EV-15 e
[F0-POLITICA-EVIDENCIA](validation/F0-POLITICA-EVIDENCIA.md).

Próximo bloco mínimo: revisão independente desta consolidação; gerência faz
uma execução física da costura candidata revisada, com comando e aceite em
[F0-LOTE3](validation/F0-LOTE3.md). Não duplicar workers nem repetir os verdes
isolados do lote2: os 46 hashes Temporal, 11 SQL e seis móveis foram conferidos
por leitura dos bytes nesta entrega. O pacote móvel é uma recuperação por nova
execução deliberada, não o trace histórico perdido. Depois: E4/T36 real sem
contas, E5 no shell real, RF-55/T28 antes de E1/E2 e SSH integrado. Nenhuma conta
real é autorizada neste bloco; G0 permanece pendente.

Não há prova de esgotamento de quota ou falha de transporte nesta consolidação.
`Operation not permitted` em namespaces e falta de make/headers foram limites
históricos do trabalhador, superados no laboratório HOST apenas no escopo provado;
RF-55 hospedado é elegibilidade; guard não integrado e percurso móvel incompleto
são lacunas técnicas. Nenhuma delas se resolve marcando sintético como integração.
`git diff --check` é o check desta entrega documental, registrado no resultado do
executor; a revisão independente e a deliberação do gate continuam próximas fases.
