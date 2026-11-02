# ADR-008 — Operações remotas por plano e pedido de parada

Estado: implementado com provas locais delimitadas, sem homologação SSH integral.

## Vínculo e compatibilidade

Migração 031 acrescenta `intent_id` à operação SSH. Todo novo start exige intenção do mesmo contexto e inclui esse vínculo no digest. O banco impede inserção nova sem vínculo e sua troca posterior. Registros históricos sem intenção permanecem consultáveis e reconciliáveis: não se inventa qual plano os originou.

A confirmação de cancelamento considera somente operações do plano. Operações históricas sem vínculo continuam bloqueando a confirmação conservadoramente no contexto. Um plano conhecido cancelado não impede o despacho de seu vizinho na mesma conversa. Settings exibe tarefas/hosts por rótulo, estado e a condição de vínculo antigo; não expõe credenciais.

## Pedido versus efeito físico

`RemoteOperations.cancel` exige um pedido de cancelamento do plano já persistido pelo caminho assinado. Confere contexto, autoridade atual e a identidade histórica da operação. O pedido remoto contém operação/projeto/tarefa/época daquela execução; não é shell livre, PID arbitrário ou autorização de novo trabalho.

O worker grava um marcador privado e devolve o estado observado, podendo ainda estar running/uncertain. Somente o supervisor pai consulta esse marcador e interrompe o grupo de seu filho ainda não reaproveitado; o RPC não sinaliza PID obtido de arquivo histórico. O pai conserva seu lock até `wait()` confirmar saída, grava código de saída e hash de log e então registra `canceled_confirmed`. Se o pedido chegar antes do filho iniciar, grava recibo explícito de não início. Se o supervisor estiver indisponível, o pedido não transforma ausência em sucesso.

O runtime admite um RemoteOperations configurado para o mesmo ledger e usa o tick existente para reconciliar cancelamentos. O launcher de fixture não ganhou hosts/credenciais reais automaticamente. O relay entrega o pedido persistido ao Happier mesmo quando a reconciliação SSH falha; o erro é reportado depois da tentativa de entrega, mantendo a autoridade no ponto de escrita.

## Evidências executadas

- `remote-plan-cancel-final-20261102.log`: build e um teste PG/contrato de transporte aprovados. Cobre vínculo imutável, start não vinculado recusado, cancelamento sem pedido recusado, plano vizinho admitido e confirmação independente. O transporte é **stub**, não conexão SSH nesta rodada.
- `remote-cancel-journal-20261102.log`: dois testes passaram em contêiner descartável sem rede. Um processo Python lento real recebeu pedido validado por época; a escrita posterior não ocorreu, o pai registrou exit negativo/hash e o replay devolveu o mesmo recibo. O teste existente de deduplicação/perda de ack também passou.
- `tests/ssh.test.ts` foi adaptado ao novo contrato, mas a bancada de dois hosts não foi reexecutada nesta rodada. As provas anteriores continuam históricas, não certificam o novo cancelamento através de SSH.

## Limites

Não é sandbox para código hostil. Descendentes que escapem do grupo exigem isolamento/cgroups adequado e homologação específica. Reinício/morte do supervisor durante o cancelamento, host físico inacessível, versão mista de workers, operação histórica sem intenção e integração móvel completa continuam pendentes. Não liberar capacidade ou declarar parada sem recibo físico confiável.
