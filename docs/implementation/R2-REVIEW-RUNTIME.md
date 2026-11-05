# Revisão independente de runtime — rodada 2

Base examinada `4aa57f06`; revisão independente, sem homologação de produto. O revisor não implementou as alterações examinadas.

## Achado: isolamento de falhas na reconciliação

Em `src/cezar.ts`, `reconcileCancellations` processa jobs nativos sequencialmente, em ordem de criação, com limite de 32. Uma recusa de supervisor indisponível, Docker incerto ou outra exceção interrompe o método antes dos demais jobs e antes de `remote.reconcileCancellationRequests`. O tick captura o erro e repete a mesma ordem. Portanto um primeiro job persistentemente incerto pode impedir outros cancelamentos independentes, inclusive SSH. O mesmo padrão existe no laço de operações em `src/remote.ts`. Este é um achado estático; testar dois jobs independentes com o primeiro persistentemente indisponível, o segundo cancelável e um cancelamento SSH pendente; confirmar progresso dos últimos sem liberar o primeiro ou ocultar o erro. Fencing e falhas globais de autoridade devem continuar interrompendo o ciclo.

## Sandbox `ae75f948` — exame preliminar

A alteração amplia a decisão de retirada para saída física não zero e permite descartar saída zero sem aplicação quando estado terminal persistido do filho ou pai autoriza; mantém verificação de recibo físico, identidade e journal. O teste adicionado verifica somente o predicado, não o controlador, Docker, retomada ou cancelamento. O acionamento de `reconcileManagedTask` em filhos terminais e após reinício é dependência declarada e está sob implementação na frente de grafo; ainda não há parecer de integração. A frente sandbox informou que prepara ensaios físicos em banco exclusivo.

## Native terminal `90e2b449` — exame preliminar

O protocolo novo valida identidade e recibo assinado, registra hashes de logs antes da remoção, reconcilia journal `prepared`, inspeciona par e rede e assina prova de remoção; preserva a retirada específica de writer managed. Para reviewer/judge concluído exige evidência persistida vinculada. O autor informou typecheck e teste com Docker/ledger simulados para ACK perdido, replay e assinatura adulterada. Isso não prova execução física nem acionamento integrado. No commit isolado só há chamadas de `retireTerminal` em `NativeVerification`: programmer standalone e retomada após falha, cancelamento ou queda depois de registrar evidência dependem de wiring adicional. O autor confirmou que essa ligação está atribuída à frente graph. Parecer de integração e prova física pendentes.

## SSH `fa198d4a` — parecer delimitado

Revisão estática: replay com digest igual chama `reconcile` (inspect) sem novo start; operação nova continua exigindo intenção ativa. O laço remoto agora tenta os pedidos restantes e devolve erro agregado. O teste de contrato afirma que uma falha não impede outra tentativa; relatório do autor registra 2/2 com dois hosts SSH sintéticos e ACK descartado. Não reexecutei a bancada. O laço nativo anterior em Cezar ainda pode impedir chegar à rotina remota; o ajuste remoto não resolve esse caso. Morte do supervisor e recuperação de locks permanecem fora da prova, conforme relatório da frente.

A prova complementar sandbox `94b24876` relata Docker e PostgreSQL reais, escrita, falha/cancelamento, ACK perdido e retomada por processo sucessor com epoch novo. O teste chama diretamente método privado e usa registros sintéticos; não valida o serviço broker completo nem o grafo. Não foi reexecutado pelo revisor; a dependência de acionamento integrado permanece.

## Wiring `9c6c39e7` — achados a corrigir

A mudança acrescenta chamada de retirada standalone e tenta processar jobs nativos independentemente antes do SSH. Porém `ORDER BY ... LIMIT 32` seleciona sempre os mesmos jobs incertos ou recusados; 32 falhas persistentes impedem o 33º de ser tentado. A nova seleção de filhos sandbox com `LIMIT 100` não exclui writers já neutralizados; os primeiros 100 filhos terminais podem manter outros de fora indefinidamente. Além disso uma exceção no laço sandbox interrompe o método antes do laço nativo e SSH. Foram solicitados ao autor teste acima dos limites, isolamento de erro e progressão durável ou outra seleção que não prive jobs posteriores. Não aprovo este commit como solução geral de inanição.

`a9453b45` remove os dois limites e captura falhas por filho sandbox e job nativo, com erro agregado após SSH. Isso resolve estaticamente os dois casos de backlog apontados; teste simulado relatado cobre 33 jobs nativos e SSH, não reexecutado pelo revisor. O custo e a latência agora crescem com o backlog. Fases anteriores como `reconcileSandbox`, QA e planning ainda podem interromper o ciclo antes de SSH; a correção não prova isolamento universal de falhas.

`28e0542a` introduz gate de processo remoto antes de executar tarefa e persiste identidades; EOF antes da liberação impede exec. Identidade ausente/divergente é tratada como incerta, inclusive operações legadas em execução. O schema aceita os campos adicionais. Não encontrei defeito concreto na revisão estática delimitada; não reexecutei os ensaios. A morte do supervisor continua incerta e não há prova de recuperação segura do grupo.

Sandbox `c90bc930` acrescenta ensaio relatado por API pública/socket e reinício de processo broker após remoção, com falha/cancelamento e sucessor. O controlador permanece harness com registros sintéticos; o grafo Cezar não é exercitado por esse teste. Fonte e limites documentais inspecionados; execução não repetida pelo revisor.
