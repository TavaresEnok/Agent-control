# ADR-007 — Vagas do grafo e capacidade física

Estado: integração implementada na bancada; dimensionamento operacional pendente.

## Problema encontrado

RunManager construído sem semaphore explícito usa o padrão standalone de dois fluxos. O limite configurável de programadores no PostgreSQL não removia esse segundo teto. Além disso, escrever apenas `status=waiting` no RunStore não participava do conjunto nativo que desconta esperas do uso de vagas.

## Implementação

O runtime injeta o WorkspaceSemaphore existente, com cache carregado do orçamento PG: programadores + avaliadores para as vagas lógicas do grafo. O refresh é compartilhado e limitado a uma vez por segundo por runtime. Configuração inacessível conserva o último cache, com inicial restrito; isso não autoriza execução sem concessão PG.

PG continua sendo a única autoridade de capacidade física, incluindo limite global, contexto, conta, papel, TTL de cota, reserva e efeito. A soma no semaphore não cria outra concessão ou outra política de seleção; evita restringir programação à configuração standalone e evita fundir artificialmente programação e avaliação em um teto de dois. A retomada autônoma por limite de uso do standalone fica desativada; fallback e reavaliação seguem a autoridade transacional.

`setManagedAdmissionWait` reaproveita o conjunto `waiting` e a notificação nativa `releaseSlot`, sem tirar o grafo de seu RunManager. Usa chaves separadas para revisores paralelos. Pausa antes do nó, falta de capacidade e aprovação humana passam a participar dessa espera. O idle timer nativo é suspenso durante a espera explícita. Ao retomar, o mesmo dono/sessão continua; o comportamento nativo de retomada de espera pode exceder momentaneamente vagas lógicas, mas nenhum worker pode ultrapassar concessões PG por isso.

O estado waiting não é declaração de que todos os processos do conselho pararam. Um membro pode aguardar enquanto outro conclui; as concessões e recibos continuam separados. Cancelamento e teardown limpam o registro de espera.

## Correção adjacente

Pedido de cancelamento remove imediatamente **somente** a espera na fila. Não libera grants running/uncertain. A consulta FIFO também exclui intenções canceladas, impedindo que uma tentativa já impedida de trabalhar conserve a cabeça da fila até uma reconciliação física demorada.

## Verificação concentrada

`managed-flow-admission-smoke-20261102.log`: quatro casos passaram, sem bateria upstream. Três workflows admitidos alcançaram uma barreira de implementação simultaneamente no RunManager, além do antigo teto de dois; depois foram pausados/cancelados sem lançar QA ou alterar a branch protegida. É prova de progresso de fluxos, **não** benchmark de três processos físicos sobrepostos. Os outros casos cobrem pausa/cota, cancelamento e aprovação humana no mesmo grafo.

`canceled-fifo-20261102.log` cobre a remoção da espera e preservação da capacidade incerta. Tipos/builds estão nos logs da mesma rodada. Não há medição de throughput real, carga representativa, oito workers reais, política de memória de produção ou provedores homologados.

A inspeção adjacente também endureceu a releitura de etapa concluída: um recibo de verificação ausente/reprovado não vira texto de sucesso, e integração diferente de `integrated` permanece recusada. Esse ajuste foi compilado, mas não recebeu prova dedicada de replay negativo nesta rodada, conforme a prioridade de implementação e validação concentrada posterior.
