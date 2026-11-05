# R4 — revisão independente de protocolo084/085

Estado: **não aprovado nesta versão**. Base do reviewer `da2c899e`; fontes do autor `9ef5aa80` e `7ab13f8c` aplicadas somente na worktree de revisão. Não houve alteração de produto pelo revisor, uso de conta real ou reexecução física redundante. Runtime mantém a revisão de hooks de recursos/rollover/fluxo; esta frente cobre a implementação do protocolo, watchdog/reaper e desenho da prova finita.

## Bloqueadores enviados ao autor e principal

1. O watchdog de `native-protocol-compatibility.ts` é executado por `/usr/local/bin/node` da imagem candidata. A imagem pode substituir esse binário e ignorar o script `-e`/prazo; o fim do controlador deixaria o processo sem a limitação declarada. A limitação deve vir de autoridade/runtime confiável independente dos bytes candidatos. A prova final precisa incluir imagem cujo node candidato ignore o script/prazo, além de SIGKILL do controlador e descendente em sessão distinta. Achado inicialmente transmitido por runtime e confirmado nesta leitura; nenhum aceite duplicado é inferido.
2. O `finally` de `r4-native-protocol-compatibility.test.ts` envia SIGKILL ao controlador sem aguardar sua saída, remove o scratch e tenta remover tags antes de fechar/dropar o banco. Se o corpo falhar antes de reconciliar os probes, podem restar contêineres; uma exceção ao retirar imagem pode impedir o restante do cleanup e encobrir a falha inicial. É necessário aguardar o filho e limpar identidades próprias verificadas pelo journal, executando cada etapa de cleanup mesmo se outra falhar e preservando o erro inicial.

## Inspeção estática sem achado impeditivo adicional

O spec é estrito e não aceita `passed`, runner, comandos, transcrições ou sucesso fornecido pelo consumidor. O digest precisa corresponder ao tipo/imagens calculados. A administração é verificada antes de observar e antes de gravar o recibo. Version/initialize/model-list são chamadas fixas, sem login ou inferência; as respostas têm limites de tamanho/modelos/páginas e cursor repetido é recusado. Erros de stream/processo reprovam a observação.

Recibos e pins são imutáveis no PostgreSQL. Promoção exige recibo existente e revisão CAS; revogação é revisão CAS e sincroniza com o pin por lock de linha. Uma tentativa nova só recebe recibo promovido não revogado com mesmo tipo/executor/modelo/esforço. O replay de uma tentativa já fixada exige exatamente o mesmo executor/modelo/esforço e conserva o recibo antigo após revogação; isso não promove novas tentativas.

O journal085 é gravado antes do efeito e conserva nome, operação, imagem, fase, prazo e identidade de contêiner observada. O reaper confere envelope e identidade antes de retirar por ID. Uma ausência anterior ao prazo mantém incerteza; tombstones aposentadas continuam elegíveis para varredura depois do prazo para recolher criação tardia. Essa segurança de criação tardia depende do watchdog realmente confiável, ainda bloqueado no item1. Não foi atribuído um passe físico aos casos ainda não executados na versão corrigida.

## Limites necessários ao eventual aceite

O ensaio é de worker/version/app-server initialize/model-list sem credenciais. `toolsImage` participa do digest de execução, mas o exec-server da imagem de tools não é observado; não demonstra compatibilidade completa do par. As imagens CLI old/new/incompatible/auth são fixtures sintéticas, sem elegibilidade oficial. Os pins9ef5aa80/7ab13f8c não contêm chamadas de hook nos supervisores; a integração de admissão real precisa do aceite separado do principal/runtime. A prova de reinício dos collectors é distinta e não foi reexecutada nem aceita em lote por esta revisão.

## Próxima evidência exigida

Pin corrigido de fonte/teste, execução física serial autorizada com log completo, incluindo watchdog confiável contra runtime candidato hostil, SIGKILL do controlador, descendente setsid, criação atrasada e cleanup de falha. O reviewer pode inspecionar essa mesma execução final com proveniência explícita de autor; não declarará uma repetição independente que não ocorreu. Este documento será atualizado com o pin e parecer efetivos.
