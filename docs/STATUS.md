# STATUS — Agent Control

**Atualização:** 2026-10-31. **Fase: F0 em fechamento de provas; G0 PENDENTE. F1 não iniciada.**
Aixle Flow `e6ec5a286120aed3a036d85871e796b2f6c97d70` é candidato aprovado
para desenvolvimento, sem homologação definitiva. A consolidação documental
está pronta para revisão independente; isso não conclui os eliminatórios.

## Continuidade e preservação

- Worktree exclusiva desta entrega: `/home/enok/srv_projetos/worktrees/14v3rrig/task-271a4475560c-g0-lote6-status`; HEAD inicial `f236c591352df51d1fabbb22d9643b9ff53463fb`, árvore inicial limpa. Clone identificado por `UPSTREAM.json`; lotes1–4 DONE/revisões independentes PASS e lote5 `9add58f6088a` DONE/revisado conforme controlador, incluindo histórico de `BUNDLE_FROZEN`. Histórico em EV-12–24/[F0-LOTE5](validation/F0-LOTE5.md); estado vigente em EV-25–26/[F0-LOTE6](validation/F0-LOTE6.md).
- Origem e entregas Zed em `/home/enok/Documentos/projetos/agent-control` preservadas, sem acesso ou cópia de produto à origem. Zed terminou conforme usuário; isso não comprova saúde de serviços.
- Controlador ativo para este fluxo conforme delegação e histórico das tarefas; não foi consultada saúde do serviço nem iniciado/reiniciado daemon. Aixle não recebeu autoridade sobre planos ativos.
- `Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat` e demais projetos permanecem pausados. Nenhum serviço, credencial real, API paga, produção, migração, deploy/push/merge ou commit nesta entrega.
- Contexto autocontido do contrato, documentos de referência, recibos versionados e commits das duas entregas fornecem a procedência desta consolidação; sem depender do transporte de `.paseo-context`. Somente documentação autorizada e metadado de resultado alterados.

## Matriz de continuidade G0

Esta síntese remete à matriz normativa completa em [F0-CHECKLIST](F0-CHECKLIST.md)
e às origens exatas em [F0-EVIDENCIAS](F0-EVIDENCIAS.md), EV-01–26.

| Critério | Estado e prova | Lacuna eliminatória / próxima evidência |
|---|---|---|
| E1 CLIs/assinaturas | NOT RUN real; EV-03/09 documental e guard sintético | Modo/plano/CLI/entitlement elegíveis e execução controlada em etapa própria |
| E2 duas contas/isolamento | Parcial sintético HOST: HOME vazou; namespaces bloquearam cinco ataques nas duas direções; EV-12 | Isolamento integrado Aixle e duas contas reais identificáveis continuam NOT RUN |
| E3 autoridade/durabilidade | Costura PG+relay+Temporal física PASS pela gerência; exit86, lease saudável sem envio, lease envelhecido em SQL, AlreadyStarted/mesmo runID/uma execução, cancel e cleanup; EV-19 | Fatia inerte, ledger vazio e reserva ocupada; sem liberação/runtime cleanup/modelos periféricos reais, sem autoridade global ou T28 global |
| E4 UI/API/WS/terminal/MCP | Unidades EV-22 preservadas; tentativas lote5 NOTRUN: EACCES administrativo e, após ownership corrigido, parada pré-web com PG apenas; cleanup PASS, EV-25 | Correções TCP final/IO de volume incorporadas, sem novo físico; executar comando de F0-LOTE6. Matriz e fechamento de bypass, IDE/files/preview e ausência global MITM/CA/proxy pendentes |
| E5 móvel | Execução parcial de componentes; novo pacote móvel retido e hashes conferidos, EV-17; transporte/dados sintéticos | Perfil conta/modelo, criação de tarefa, reenvio com efeito único, reconexão e estado/grafo reais no shell autenticado |
| E6 licença | Documental concluído; Apache-2.0, EV-02/05 | Preservar licença/avisos e estratégia privada no fork |
| E7 SSH | Unidades EV-22 preservadas; lote5 FAIL setup por docker cp/tmpfs, transporte remoto NOTRUN. Exec/stdin positivo apenas administrativo; recursos próprios removidos, retenção antiga falhou, EV-25 | IO corrigido e captura separada da remoção, sem novo físico; hostkey negativa/positiva, bundle/SHA/teste remoto, efeito único e marcador central ausente pendentes |
| AD1 RF-55/T39 | Documental + 24 recusas standalone, EV-09/24; CLI oficial pessoal remota direta `documented_supported` no escopo das fontes | UI privada Aixle `requires_clarification` na fronteira hospedada; conta/plano/entitlement não verificados, guard global NOT RUN |
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

Próximo bloco mínimo: revisão independente desta consolidação e confirmação dos
pareceres das correções lote6; gerência executa os comandos de
[F0-LOTE6](validation/F0-LOTE6.md), com imagem de acesso corrigida `439b8d`,
subnet revalidada e `--seccomp-compat` explícito. Correções de acesso `99c3198`
e SSH `4ca779c` incorporadas em `f236c59`; implementadas/revisadas conforme
controlador, aguardam execução física gerencial. Documentos das frentes ainda
registram revisão pendente no marco de implementação; não são recibos de parecer.
Não repetir build/testes Ruby, Temporal/SQL/costura/browser verdes por rotina.
A conferência dos 21 hashes do preflight lote4 pertence ao lote5, sem nova
conferência aqui. O pacote móvel EV-17/19 continua parcial sintético.
Depois: fechar bypass E4 com contraprova, E5 no shell real e RF-55/T28 antes de
E1/E2 em etapa própria. Launcher nativo sintético é proposta NOT RUN; nenhuma
conta real autorizada, G0 permanece pendente e F1 não iniciada.

Conforme controlador, a fila lote4 retomou na mesma conta após recuperação de
cota e concluiu com revisão PASS, sem substitutos. Não se mediu saldo ou data de
reset nesta entrega. Essa recuperação é distinta do preparo técnico IPAM/seccomp:
pool automático esgotado e `ThreadError EPERM` no perfil padrão continuam
falhas físicas preservadas. Rede interna criada/removida e ttyd fixado resolvem
preparo, sem provar fronteira de segurança, SSH remoto ou elegibilidade RF55.
`git diff --check` é o check desta entrega documental, registrado no resultado do
executor; a revisão independente e a deliberação do gate continuam próximas fases.
