# STATUS — Agent Control

**Atualização:** 2026-10-31. **Fase: F0 em fechamento de provas; G0 PENDENTE. F1 não iniciada.**
Aixle Flow `e6ec5a286120aed3a036d85871e796b2f6c97d70` é candidato aprovado
para desenvolvimento, sem homologação definitiva. A consolidação documental
está pronta para revisão independente; isso não conclui os eliminatórios.

## Continuidade e preservação

- Worktree exclusiva desta entrega: `/home/enok/srv_projetos/worktrees/14v3rrig/task-b15c348c94b6-g0-lote4-status`; HEAD inicial `c78bd74`, árvore inicial limpa. Clone identificado por `UPSTREAM.json`; lotes1–3 DONE/revisões independentes PASS conforme controlador, incluindo correção de `BUNDLE_FROZEN` e nova revisão. Histórico em EV-12–18/[F0-LOTE2](validation/F0-LOTE2.md)/[F0-LOTE3](validation/F0-LOTE3.md); estado vigente em EV-19–21/[F0-LOTE4](validation/F0-LOTE4.md).
- Origem e entregas Zed em `/home/enok/Documentos/projetos/agent-control` preservadas, sem acesso ou cópia de produto à origem. Zed terminou conforme usuário; isso não comprova saúde de serviços.
- Controlador ativo para este fluxo conforme delegação e histórico das tarefas; não foi consultada saúde do serviço nem iniciado/reiniciado daemon. Aixle não recebeu autoridade sobre planos ativos.
- `Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat` e demais projetos permanecem pausados. Nenhum serviço, credencial real, API paga, produção, migração, deploy/push/merge ou commit nesta entrega.
- Contexto autocontido do contrato, documentos de referência, recibos versionados e commits das duas entregas fornecem a procedência desta consolidação; sem depender do transporte de `.paseo-context`. Somente documentação autorizada e metadado de resultado alterados.

## Matriz de continuidade G0

Esta síntese remete à matriz normativa completa em [F0-CHECKLIST](F0-CHECKLIST.md)
e às origens exatas em [F0-EVIDENCIAS](F0-EVIDENCIAS.md), EV-01–21.

| Critério | Estado e prova | Lacuna eliminatória / próxima evidência |
|---|---|---|
| E1 CLIs/assinaturas | NOT RUN real; EV-03/09 documental e guard sintético | Modo/plano/CLI/entitlement elegíveis e execução controlada em etapa própria |
| E2 duas contas/isolamento | Parcial sintético HOST: HOME vazou; namespaces bloquearam cinco ataques nas duas direções; EV-12 | Isolamento integrado Aixle e duas contas reais identificáveis continuam NOT RUN |
| E3 autoridade/durabilidade | Costura PG+relay+Temporal física PASS pela gerência; exit86, lease saudável sem envio, lease envelhecido em SQL, AlreadyStarted/mesmo runID/uma execução, cancel e cleanup; EV-19 | Fatia inerte, ledger vazio e reserva ocupada; sem liberação/runtime cleanup/modelos periféricos reais, sem autoridade global ou T28 global |
| E4 UI/API/WS/terminal/MCP | Laboratório Rails descartável implementado/revisado conforme controlador; físico NOT RUN, EV-20 | Executar build e matriz; probe direto ttyd pode registrar FAIL de bypass; IDE/files/preview completos e ausência global MITM/CA/proxy continuam NOT RUN |
| E5 móvel | Execução parcial de componentes; novo pacote móvel retido e hashes conferidos, EV-17; transporte/dados sintéticos | Perfil conta/modelo, criação de tarefa, reenvio com efeito único, reconexão e estado/grafo reais no shell autenticado |
| E6 licença | Documental concluído; Apache-2.0, EV-02/05 | Preservar licença/avisos e estratégia privada no fork |
| E7 SSH | Transporte OpenSSH reutiliza runner/journal/status Aixle; implementado/revisado conforme controlador, EV-21 | Gate físico NOT RUN: hostkey negativa/positiva, bundle/SHA/teste remoto, um efeito e marcador central ausente; sem contas IA reais |
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

Próximo bloco mínimo: revisão independente desta consolidação; gerência executa
o build E4 com testes dirigidos de cookie/MCP e, com IDs imutáveis, a matriz
Rails/PG/gateway/ttyd. Em frente independente, executar gate E7 com duas imagens
locais imutáveis. Comandos e critérios em [F0-LOTE4](validation/F0-LOTE4.md).
Sem recibos HOST novos, ambos permanecem PENDENTES. Não duplicar workers nem
repetir Temporal5/SQL9/costura/browser verdes: conferência offline nesta entrega
validou 21 hashes integrados, seis móveis e o verifier dos recibos. O pacote móvel
contém 7.858.710 bytes de componentes/transporte sintético, sem shell autenticado;
é nova execução deliberada, não recuperação do trace histórico perdido.
Depois: fechar bypass E4 com contraprova, E5 no shell real e RF-55/T28 antes de
E1/E2 em etapa própria. Nenhuma conta real autorizada; G0 permanece pendente.

Não há prova de esgotamento de quota ou falha de transporte nesta consolidação.
`Operation not permitted` em namespaces e falta de make/headers foram limites
históricos do trabalhador, superados no laboratório HOST apenas no escopo provado;
RF-55 hospedado é elegibilidade; guard não integrado e percurso móvel incompleto
são lacunas técnicas. Nenhuma delas se resolve marcando sintético como integração.
`git diff --check` é o check desta entrega documental, registrado no resultado do
executor; a revisão independente e a deliberação do gate continuam próximas fases.
