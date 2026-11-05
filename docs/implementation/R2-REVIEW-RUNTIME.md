# Revisão independente de runtime — rodada 2

Base examinada `4aa57f06`; revisão independente, sem homologação de produto. O revisor não implementou as alterações examinadas.

## Achado: isolamento de falhas na reconciliação

Em `src/cezar.ts`, `reconcileCancellations` processa jobs nativos sequencialmente, em ordem de criação, com limite de 32. Uma recusa de supervisor indisponível, Docker incerto ou outra exceção interrompe o método antes dos demais jobs e antes de `remote.reconcileCancellationRequests`. O tick captura o erro e repete a mesma ordem. Portanto um primeiro job persistentemente incerto pode impedir outros cancelamentos independentes, inclusive SSH. O mesmo padrão existe no laço de operações em `src/remote.ts`. Este é um achado estático; testar dois jobs independentes com o primeiro persistentemente indisponível, o segundo cancelável e um cancelamento SSH pendente; confirmar progresso dos últimos sem liberar o primeiro ou ocultar o erro. Fencing e falhas globais de autoridade devem continuar interrompendo o ciclo.

## Sandbox `ae75f948` — exame preliminar

A alteração amplia a decisão de retirada para saída física não zero e permite descartar saída zero sem aplicação quando estado terminal persistido do filho ou pai autoriza; mantém verificação de recibo físico, identidade e journal. O teste adicionado verifica somente o predicado, não o controlador, Docker, retomada ou cancelamento. O acionamento de `reconcileManagedTask` em filhos terminais e após reinício é dependência declarada e está sob implementação na frente de grafo; ainda não há parecer de integração. A frente sandbox informou que prepara ensaios físicos em banco exclusivo.

## Native terminal `90e2b449` — exame preliminar

O protocolo novo valida identidade e recibo assinado, registra hashes de logs antes da remoção, reconcilia journal `prepared`, inspeciona par e rede e assina prova de remoção; preserva a retirada específica de writer managed. Para reviewer/judge concluído exige evidência persistida vinculada. O autor informou typecheck e teste com Docker/ledger simulados para ACK perdido, replay e assinatura adulterada. Isso não prova execução física nem acionamento integrado. No commit isolado só há chamadas de `retireTerminal` em `NativeVerification`: programmer standalone e retomada após falha, cancelamento ou queda depois de registrar evidência dependem de wiring adicional. O autor confirmou que essa ligação está atribuída à frente graph. Parecer de integração e prova física pendentes.
