# STATUS — Agent Control

**Atualização:** 2026-10-31. **Fase: F0 em fechamento de provas; G0 PENDENTE. F1 não iniciada.**
Aixle Flow `e6ec5a286120aed3a036d85871e796b2f6c97d70` é candidato aprovado
para desenvolvimento, sem homologação definitiva. A consolidação documental
está pronta para revisão independente; isso não conclui os eliminatórios.

## Continuidade e preservação

- Worktree exclusiva desta entrega: `/home/enok/srv_projetos/worktrees/14v3rrig/task-7807ea5f00cd-g0-lote7-status`; HEAD inicial `9f28ff9`, árvore inicial limpa. Clone identificado por `UPSTREAM.json`; lotes1–4 DONE/revisões independentes PASS, lote5 `9add58f6088a` e lote6 `271a4475560c` DONE/revisados conforme controlador, incluindo histórico de `BUNDLE_FROZEN`. Histórico em EV-12–28/F0-LOTE5–6; estado posterior em EV-29/[F0-LOTE7](validation/F0-LOTE7.md).
- Origem e entregas Zed em `/home/enok/Documentos/projetos/agent-control` preservadas, sem acesso ou cópia de produto à origem. Zed terminou conforme usuário; isso não comprova saúde de serviços.
- Controlador ativo para este fluxo conforme delegação e histórico das tarefas; não foi consultada saúde do serviço nem iniciado/reiniciado daemon. Aixle não recebeu autoridade sobre planos ativos.
- `Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat` e demais projetos permanecem pausados. Nenhum serviço, credencial real, API paga, produção, migração, deploy/push/merge ou commit nesta entrega.
- Contexto autocontido do contrato, documentos de referência, recibos versionados e commits das duas entregas fornecem a procedência desta consolidação; sem depender do transporte de `.paseo-context`. Somente documentação autorizada e metadado de resultado alterados.

## Matriz de continuidade G0

Esta síntese remete à matriz normativa completa em [F0-CHECKLIST](F0-CHECKLIST.md)
e às origens exatas em [F0-EVIDENCIAS](F0-EVIDENCIAS.md), EV-01–29.

| Critério | Estado e prova | Lacuna eliminatória / próxima evidência |
|---|---|---|
| E1 CLIs/assinaturas | NOT RUN real; EV-03/09 documental e guard sintético | Modo/plano/CLI/entitlement elegíveis e execução controlada em etapa própria |
| E2 duas contas/isolamento | Parcial sintético HOST: HOME vazou; namespaces bloquearam cinco ataques nas duas direções; EV-12 | Isolamento integrado Aixle e duas contas reais identificáveis continuam NOT RUN |
| E3 autoridade/durabilidade | Costura PG+relay+Temporal física PASS pela gerência; exit86, lease saudável sem envio, lease envelhecido em SQL, AlreadyStarted/mesmo runID/uma execução, cancel e cleanup; EV-19 | Fatia inerte, ledger vazio e reserva ocupada; sem liberação/runtime cleanup/modelos periféricos reais, sem autoridade global ou T28 global |
| E4 UI/API/WS/terminal/MCP | Lote7 físico gerencial: readiness backend/gateway PASS; matriz 81 PASS, 4 FAIL, 1 NOTRUN; cleanup PASS, EV-29 | Shell anônimo por ttyd direto e subscription cross-tenant confirmados; MCP worker e revogação WS FAIL requerem diagnóstico. IDE/files/preview NOTRUN; acesso não aprovado |
| E5 móvel | Execução parcial de componentes; novo pacote móvel retido e hashes conferidos, EV-17; transporte/dados sintéticos | Perfil conta/modelo, criação de tarefa, reenvio com efeito único, reconexão e estado/grafo reais no shell autenticado |
| E6 licença | Documental concluído; Apache-2.0, EV-02/05 | Preservar licença/avisos e estratégia privada no fork |
| E7 SSH | SSH físico PASS pela gerência: pin negativo, repo só no destino, bundle/SHA/teste remoto, uma execução, polls em conexões novas, marcador sintético ausente, journal/cleanup PASS, EV-27 | Consolidado sem repetição; standalone Settings, sem CoderPrepareRepo/MCP/SQL/IA autenticada e sem queda forçada de canal. Não fecha F4 completo, E1/E2 ou G0 |
| AD1 RF-55/T39 | Documental + 24 recusas standalone, EV-09/24; CLI oficial pessoal remota direta `documented_supported` no escopo das fontes | UI privada Aixle `requires_clarification` na fronteira hospedada; conta/plano/entitlement não verificados, guard global NOT RUN |
| AD2 RF-46/T28 | Preservação sem contas reais, EV-11 | T28 real NOT RUN; autoridade comum ou contas explicitamente não sobrepostas antes de chamada |
| COMP | Comparação estática concluída, ADR-001/EV-02/04/05 | Notas 3,40 Aixle / 2,25 Kandev não anulam eliminatórios |

## Política e parada

A escolha do candidato e instalação isolada já foram autorizadas. As pendências
antigas de nova autorização genérica estão encerradas; ambiente, elegibilidade,
contas em etapa própria e gates continuam exigidos. Política exclusiva deste
projeto no contrato: gerente `codex/gpt-6.1-sol high`; programador e revisor
`codex-programmer/gpt-6.1-sol medium` em sessões distintas, sem fallback.
Sem cota, aguardar recuperação confirmada na mesma conta. A política
administrativa de runtime da sessão não substitui esta regra documentada.

Após a revisão independente deste fechamento, há parada persistente para handoff
a outra IA, conforme instrução do proprietário. Receita e gates restantes são
histórico/backlog sem autorização de execução; não iniciar correções ou novo lote.
Encaminhar os negativos e lacunas de EV-29. Não repetir SSH físico PASS ou outros
verdes. RF-55 para UI hospedada segue `requires_clarification`; RF-46/T28 real e
contas reais não ativados. G0 permanece pendente e F1 não iniciada.

Conforme controlador, a fila lote4 retomou na mesma conta após recuperação de
cota e concluiu com revisão PASS, sem substitutos. Não se mediu saldo ou data de
reset nesta entrega. Essa recuperação é distinta do preparo técnico IPAM/seccomp:
pool automático esgotado e `ThreadError EPERM` no perfil padrão continuam
falhas físicas preservadas. Rede interna criada/removida e ttyd fixado resolvem
preparo, sem provar fronteira de segurança, SSH remoto ou elegibilidade RF55.
`git diff --check` é o check desta entrega documental, registrado no resultado do
executor; a revisão independente precede a parada registrada acima.
