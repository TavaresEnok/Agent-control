# STATUS — Agent Control

**Atualização:** 2026-10-31. **Fase: F0 em fechamento de provas; G0 PENDENTE. F1 não iniciada.**
Aixle Flow `e6ec5a286120aed3a036d85871e796b2f6c97d70` é candidato aprovado
para desenvolvimento, sem homologação definitiva. A consolidação documental
está pronta para revisão independente; isso não conclui os eliminatórios.

## Continuidade e preservação

- Worktree exclusiva desta entrega: `/home/enok/srv_projetos/worktrees/14v3rrig/task-e59f2072f8f4-g0-consolidar`; HEAD inicial `50d3387f21778dacd7f2e9c6147fbcaf650bbe99`, árvore inicial limpa. Clone de desenvolvimento identificado por `UPSTREAM.json`, com as entregas de fronteiras, mobile e Temporal incorporadas.
- Origem e entregas Zed em `/home/enok/Documentos/projetos/agent-control` preservadas; não acessadas nem alteradas nesta consolidação. A continuação explícita autoriza esta worktree, sem assumir que Zed terminou na origem.
- Controlador ativo para este fluxo conforme delegação e histórico das tarefas; não foi consultada saúde do serviço nem iniciado/reiniciado daemon. Aixle não recebeu autoridade sobre planos ativos.
- `Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat` e demais projetos permanecem pausados. Nenhum serviço, credencial real, API paga, produção, migração, deploy/push/merge ou commit nesta entrega.
- `.paseo-context.md` ausente. Contrato atual, Plano v1.1, Adendo, baseline e os três relatórios/diffs forneceram contexto suficiente. Somente documentação autorizada alterada.

## Matriz de continuidade G0

Esta síntese remete à matriz normativa completa em [F0-CHECKLIST](F0-CHECKLIST.md)
e às origens exatas em [F0-EVIDENCIAS](F0-EVIDENCIAS.md), EV-01–11.

| Critério | Estado e prova | Lacuna eliminatória / próxima evidência |
|---|---|---|
| E1 CLIs/assinaturas | NOT RUN real; EV-03/09 documental e guard sintético | Modo/plano/CLI/entitlement elegíveis e execução controlada em etapa própria |
| E2 duas contas/isolamento | Parcial negativo; HOME vazou, namespace NOT RUN; EV-06 histórico e EV-09 atual | Ambiente OS permitido, isolamento na base e duas contas reais identificáveis |
| E3 autoridade/durabilidade | Código/harness; integração Temporal NOT RUN; EV-05/08 | Ruby/SDK/CLI; executar harness e depois contrato real de admissão/relay/outbox da base |
| E4 UI/API/WS/terminal/MCP | Auditoria fixa; execução T36 NOT RUN; EV-09 | Laboratório de gateway/rede com testes negativos inclusive acesso direto; retirar MITM/CA/proxy e fechar bypass |
| E5 móvel | Execução parcial de componentes com transporte/dados sintéticos; EV-10 | Perfil conta/modelo, criação de tarefa, reenvio com efeito único, reconexão e estado/grafo reais no shell autenticado |
| E6 licença | Documental concluído; Apache-2.0, EV-02/05 | Preservar licença/avisos e estratégia privada no fork |
| E7 SSH | Execução histórica loopback/segredo sintético, EV-07 | Destino dedicado de teste e transporte Aixle/OpenSSH com hostkey, artefato/teste e IA central; NOT RUN integrado |
| AD1 RF-55/T39 | Documental + 24 recusas standalone, EV-09 | Codex hospedado/remoto requires_clarification; guard global na base NOT RUN |
| AD2 RF-46/T28 | Preservação sem contas reais, EV-11 | T28 real NOT RUN; autoridade comum ou contas explicitamente não sobrepostas antes de chamada |
| COMP | Comparação estática concluída, ADR-001/EV-02/04/05 | Notas 3,40 Aixle / 2,25 Kandev não anulam eliminatórios |

## Autorizações, política e próximo bloco

A escolha do candidato e instalação isolada já foram autorizadas. As pendências
antigas de nova autorização genérica estão encerradas; ambiente, elegibilidade,
contas em etapa própria e gates continuam exigidos. A política exclusiva histórica
é origem documental dos relatórios; a política administrativa v3 recebida nesta
sessão substitui as regras históricas de modelos/contas. Esta entrega continua
no executor Codex já delegado, sem agentes ou fallback. O controlador aplica a
política vigente na próxima revisão independente. Detalhes de precedência e
restrições em [F0-RETOMADA](validation/F0-RETOMADA.md).

Próximo bloco mínimo: revisão independente desta consolidação e das evidências
insuficientemente resumidas; gerente disponibiliza toolchain/headers ou Ruby
4.0.9 isolado; executor executa preflight, testes Ruby essenciais e harness
Temporal existente, preservando históricos/manifest/resultados. Receita e comandos
administrativos em [F0-RETOMADA](validation/F0-RETOMADA.md). Não repetir mobile/guard
verdes sem mudança ou evidência faltante que justifique. Os artefatos móveis
report/trace/capturas não estão nesta worktree: obter e conferir hashes da entrega
produtora antes de usá-los como evidência direta.

Não há prova de esgotamento de quota ou falha de transporte nesta consolidação.
`Operation not permitted` em namespaces e falta de make/headers são ambiente;
RF-55 hospedado é elegibilidade; guard não integrado e percurso móvel incompleto
são lacunas técnicas. Nenhuma delas se resolve marcando sintético como integração.
`git diff --check` é o check desta entrega documental, registrado no resultado do
executor; a revisão independente e a deliberação do gate continuam próximas fases.
