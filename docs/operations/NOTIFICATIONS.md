# Atualizações agrupadas no chat existente

RF-35 parcial: atualizações do controlador usam a mesma conversa Happier
cifrada do projeto/contexto. Não há outro transcript, scheduler, serviço de
push ou conta de IA. O heartbeat já existente do `HappierEndpoint.tick()`
observa estados, agrupa conclusões e drena a outbox nativa.

## Política e comportamento

Configuração opcional de startup em `HappierEndpoint.options.notificationPolicy`:

| Campo | Default | Limite |
|---|---:|---:|
| `completionWindowMs` | 2000 ms | 0–30000 ms |
| `maxBatchSize` | 20 observações por mensagem | 1–100 |
| `maxDeliveriesPerTick` | 50 mensagens | 1–100 |

O primeiro resultado abre uma janela limitada; quando o resultado mais antigo
vence, as conclusões próximas pendentes entram na mesma atualização, até o
limite. Fluxo contínuo não reinicia indefinidamente o timer. O flush roda no
próximo heartbeat, sem adicionar timer concorrente. Backlog excedente continua
durável para a rodada seguinte.

Bloqueios importantes não aguardam a janela: cota/capacidade indisponível,
admissão fechada, falta/medição de disco, falha de execução, reconciliação e
pedido de cancelamento. Uma pausa humana sozinha é preservada sem produzir
alerta crítico repetido. Cancelamento só é anunciado como confirmado quando o
estado durável de cancelamento está `confirmed`, não pela mera parada da UI.

O relay publica somente mudanças semânticas: um fluxo que continua esperando
pelo mesmo motivo não cria nova mensagem para cada evento ou tick. Depois de
recuperar e entrar no mesmo bloqueio outra vez, há um episódio novo. Conclusão
`review` é descrita como aguardando parecer, sem declarar integração aprovada.

As subentregas de um workflow pai não são despachadas pelo heartbeat: a query
seleciona apenas intenções com `parent_intent_id IS NULL` (migração036). O
RunManager do pai continua como autoridade do grafo; notificações não criam
filhos, conversas ou execução paralela por conta própria.

## Persistência, E2EE e entrega

`ac_notification_cursors/items` guardam somente referências, estados e motivos
de enums limitados. Nenhum texto de prompt, transcript ou erro livre entra
nessas tabelas. Texto é renderizado em memória e cifrado pela fronteira Happier
existente; apenas ciphertext entra em `ac_chat_messages`, junto da conversa
canônica já existente. A criação da mensagem e o vínculo dos itens são
atômicos no PG. Observação ainda não publicada pode ser supersedida por fase
nova, mas ciphertext atribuído e recibos não são reescritos.

A outbox mantém prioridade de publicação: mensagens de usuário novas 100,
bloqueios 50 e conclusões 0. A ordem entre itens da mesma prioridade usa a
sequência durável. Mensagens já enviadas não são reordenadas nem alteradas.

O envio revalida chave/vínculo de sessão e autoridade/lease antes de cada
publicação. Pausa de execução não desliga a entrega do que já foi confirmado
no controlador. Gestor stale não publica pelo caminho de entrega validado e
não marca envio confirmado. Não há liberação de grants ou alteração de QA,
aprovação/integrador por causa de notificação.

O ACK precisa corresponder ao protocolo nativo examinado: `ok:true`, ID,
sequência positiva, `localId` correspondente e `didWrite` booleano. ACK vazio,
negativo, incompatível ou perdido mantém a outbox pendente. Retry usa exatamente
o mesmo `localId` e ciphertext; a deduplicação do Happier é a fronteira contra
duplicação da escrita remota. O ID/seq/localId confirmado forma um recibo PG
imutável em `ac_chat_publication_receipts`; a resposta de retry pode ter
`didWrite:false` sem mudar a identidade da publicação anterior.

**Limite de rede:** uma troca de época depois do último fence e antes de um ACK
pode deixar confirmação local incerta. A solução é repetir a mesma identidade
idempotente, não gerar outro conteúdo/ID nem inferir que não houve entrega.
Esta implementação não acrescenta um publisher fence novo ao servidor Happier
e não presume que transporte HTTP/socket forneça exactly-once.

## Prova e pendências

A prova focada usa PG descartável, criptografia **nativa** Happier e um
publicador interceptado com identidade/deduplicação explícita. Exercita janela
e agrupamento de duas conclusões, bloqueio sem delay, repetição de observação,
ACK inválido/perdido, retry do mesmo ciphertext/localId, recibo imutável,
contexto pausado e manager stale. Uma extensão chama o `tick()` existente com
transporte/runtime interceptados, sem conta, modelo ou servidor remoto real.

Isso não comprova push Android/iOS, entrega em rede móvel, preferências visuais
no painel, acessibilidade das notificações, quota real, nem compatibilidade de
todos os servidores Happier. Nenhuma instalação operacional foi reconfigurada.
Configuração amigável pelo painel e homologação móvel permanecem trabalho
posterior, sem declarar RF-35/I6/P1 totalmente aceitos.
