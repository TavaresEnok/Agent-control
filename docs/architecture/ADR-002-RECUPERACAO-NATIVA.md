# ADR-002 — continuar o grafo nativo após reconciliar a implementação

Estado: implementado e verificado em bancada sintética; não homologado para produção.

O Cezar continua sendo o único executor do grafo. Seu comportamento anterior para execuções gerenciadas aguardava reconciliação no reinício; recuperar apenas o commit no PostgreSQL não fazia o grafo continuar. Um controlador substituto não pode resolver isso iniciando outro run ou repetindo a programação.

O fork acrescenta `RunManager.resumeConfirmedNode(runId)`. Esse método só aceita uma execução gerenciada, inativa, fora da fila, estacionada com o motivo específico de reconciliação e cujo cursor aponta para um agente. Perguntas pendentes e gates continuam bloqueados. A autorização injetada é novamente consultada antes de recolocar o mesmo run na fila nativa. O comportamento standalone permanece igual.

`CezarRuntime.recoverManaged` é chamado pelo heartbeat existente da conversa. Ele limita a consulta por contexto, reconcilia a implementação no broker, valida a worktree original e vincula o gerente atual. A autorização exige operação concluída, concessão liberada, job físico concluído e a definição de workflow congelada. A pausa humana e o fechamento de admissão impedem a retomada. Não há novo scheduler, run ou concessão de programação nesse percurso.

Quando o grafo revisita a implementação confirmada, `IsolatedImplementation` verifica o recibo persistido, a concessão, o job e o HEAD/árvore da worktree. Devolve o resultado já existente sem chamar `start` no broker. QA, revisão, juiz e integração seguem pelos nós originais do Cezar.

A prova `native-recovery.test.ts` encerra o controlador filho com SIGKILL depois do resultado físico e antes de sua aplicação pelo controlador. O sucessor reconcilia com o contexto pausado, não inicia QA, e depois da retomada explícita conclui o mesmo grafo com o commit aprovado. O cliente substituto registra zero novos starts de programação. A contraprova sem a chamada à retomada nativa falha porque o run permanece waiting; ambas as saídas foram preservadas.

Arquivos upstream alterados: `packages/cezar/src/workflows/run.ts`. O inventário `upstream/CHANGES.json` registra o hash atualizado. A aplicação importa a compilação desse mesmo arquivo, sem patch manual de dist.

Limites: a prova cobre a interrupção da implementação sintética antes do QA. Reinícios em QA/revisão/juiz/integração, pause concorrente entre nós, quedas do broker durante worker ativo, CLIs reais e revisores isolados ainda exigem implementação e homologação. Uma operação cujo resultado permanece incerto não é relançada automaticamente. Revisão independente continua pendente.

Na continuação da restauração, foi identificada a limpeza nativa de processos por `CEZ_TASK_ID`: um run restaurado mantém seu ID, portanto esse mecanismo poderia sinalizar um processo da origem. O modo gerenciado agora recusa essa limpeza nativa; somente o broker pode neutralizar seus workers por identidade física e autoridade. O comportamento standalone foi preservado. `managed-process-reaper-red-20261102.log` mostra a falha sem a correção; a suíte focada com os três casos passou após o ajuste.
