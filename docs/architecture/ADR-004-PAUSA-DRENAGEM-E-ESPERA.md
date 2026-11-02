# ADR-004 — Pausa, drenagem e espera no grafo existente

Estado: implementado parcialmente na bancada, sem homologação de produção.

## Semânticas

- **Pausar novas etapas:** conserva o cursor do grafo Cezar. O trabalho físico já iniciado pode concluir; o próximo nó aguarda a retomada explícita, sem consumir outra iteração ou criar outra sessão.
- **Drenar:** recusa novos planos e permite terminar todos os planos anteriormente aceitos, inclusive os que aguardavam capacidade. A repetição da intenção aceita continua idempotente. Não modifica a pausa. Retirar drenagem não retoma uma pausa nem abre admissão global.
- **Esperar capacidade:** QA, revisão e julgador conservam a operação e o attempt ID enquanto a concessão é recusada temporariamente. Ausência de cota não é uma reprovação do artefato.
- **Cancelar:** permanece uma operação diferente. Os novos botões não afirmam que processos foram cancelados. O fluxo público completo de cancelamento e sua confirmação física continuam pendentes.

Drenagem e pausa têm revisões independentes, assinatura de dispositivo, ACL e deduplicação transacional. Ativar drenagem é permitido com admissão global fechada; desativá-la não. A recusa de um novo plano ocorre antes de qualquer incremento de revisão, operação ou outbox.

## Reaproveitamento

Apenas um hook de admissão foi acrescentado ao walker nativo do Cezar, depois de persistir o cursor e antes de iniciar o nó. O controlador aguarda fora de transações, permitindo que a retomada humana obtenha os locks. Não há scheduler novo, mudança da definição congelada nem cópia de histórico do Happier.

## Evidências e limites

`context-drain-pause-final-20261102.log`: quatro testes passaram; cobre assinatura/revisão/deduplicação, recusa de novos planos, conclusão de plano aceito e pausa antes do QA. A primeira execução negativa usou canal de teste não previsto pelo schema; o teste foi corrigido para `api`, mantendo o constraint e o log original.

`native-pause-capacity-20261102.log`: implementação concluída → pausa → QA sem operação criada → retomada sem cota → uma operação de QA aguardando e nenhuma concessão → cota sintética disponível → integração do mesmo commit. Uma implementação e um run.

A pausa é checada novamente nos pontos de efeito existentes. Uma pausa concorrente depois do hook ainda pode interromper a preparação posterior e exigir reconciliação; não foi homologada a recuperação de todos esses intervalos. Crash durante espera de QA/revisão, interface móvel, cotas reais e cancelamento físico permanecem abertos. O estado `waiting` nativo é usado para a pausa no limite do nó; não é recibo de encerramento físico.
