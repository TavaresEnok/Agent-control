# R2: retirada de writer sandbox terminal

O broker aceita retirar o writer gerenciado quando o container inspecionado terminou com erro. Para um container que terminou com sucesso sem aplicação da operação, a retirada exige decisão persistida `failed` ou `canceled` no filho ou no pai. Uma operação concluída continua exigindo recibo de implementação idêntico. A reconciliação de tarefa gerenciada executa cleanup antes de devolver falha; a execução inicial também o faz quando recebe falha física.

O protocolo existente mantém o diretório de trabalho, bundle e logs. Ele inspeciona a identidade e estado do container, arquiva e valida o log, grava journal `prepared`, remove o container exato, confirma ausência por ID e nome e grava prova assinada antes de neutralizar o writer. Uma interrupção ou ACK perdido deixa o journal preparado para retomada sob fencing. O grant só é liberado pelo broker após inspeção física de processo terminado e registro do recibo físico; a liberação da cópia exige ainda a prova de remoção.

A integração do controlador deve chamar `reconcileManagedTask` para filhos terminais/cancelados, inclusive depois de reiniciar, até obter um resultado terminal; `uncertain` não autoriza reutilização. O método não inicia um segundo container. A alteração do controlador está fora deste escopo.

Validação local: teste focado `tests/sandbox-retirement-terminal.test.ts` e typecheck TypeScript. Este teste cobre a decisão terminal, mas não substitui ensaio físico Docker de falha, cancelamento, perda de ACK e retomada por outro broker/controlador; esses cenários dependem de infraestrutura isolada.
