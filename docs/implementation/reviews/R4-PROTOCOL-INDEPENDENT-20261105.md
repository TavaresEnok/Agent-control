# R4 — revisão independente de protocolo084/085

**Aprovado no escopo delimitado abaixo.** Base do reviewer `da2c899e`. Fontes do autor revisadas: `9ef5aa80`, `7ab13f8c`, `a92a8aec`, `afa2d505`, `7993003d`, `0fd3869c` e `d22fdac3`; documentação intermediária `43c21fdc` e fechamento de evidência `f728e357`. O reviewer não alterou produto e não repetiu a prova física pesada. Este parecer substitui o checkpoint bloqueado `2abfd052`.

## Evidência e proveniência

O autor executou a suíte física final, em slot serial autorizado pelo principal, com fonte `d22fdac3`. O reviewer leu o fonte integral, as assertivas e o log completo: **1/1, zero skips, exit0, 65,515s**. Não é apresentado como reexecução física independente. Log `docs/validation/evidence/r4-native-protocol-compatibility-20261105.log`, SHA256 `1834f3ad595f93f257f614d043c44fa382cdf0af75bc195d711ce71b9f90106f`. O readback do reviewer não encontrou contêiner com `agent-control.protocol-check=true`. O fechamento `f728e357` contém esse mesmo log (hash conferido), a confirmação de typecheck raiz exit0 e cleanup de PostgreSQL/bancos filhos/imagens próprios. A emissão upstream permanece exit2 por erro preexistente e não foi transformada em build verde. O principal integra esse fechamento junto deste parecer.

A prova usa PostgreSQL real, subprocessos host e Docker reais, onze imagens próprias com CLIs sintéticas e nenhum login/inferência. Observa versão/initialize/model-list, bloqueio antes da promoção, modelo/esforço divergente, pin imutável, publicação/revogação de promoção e preservação do pin anterior. Sete candidatos são recusados: wire shape incompatível, auth recusada, timeout, saída precoce, versão com stdout válido/exit73, versão com stdout acima do limite e imagem com VOLUME inesperado. As últimas três recusas não são atribuídas a elegibilidade oficial.

Há contraprovas físicas de SIGKILL do controlador com descendente em setsid, node candidato hostil, prazo já vencido antes de create/start e recolhimento posterior de resíduo criado parado. Um probe vivo impede concorrente por `NATIVE_PROTOCOL_PROBE_BUSY`. Os casos mortos aguardam o deadline persistido antes da reconciliação; as linhas62/90 do teste já faziam isso, portanto a suspeita intermediária do reviewer sobre falta dessa espera foi retirada sem exigir alteração.

## Achados fechados pela autoria

| Achado | Correção revisada |
| --- | --- |
| Watchdog sob node da imagem candidata podia ignorar o prazo | `a92a8aec`: supervisor destacado sob inode Node já carregado do host; código e comandos fixos; create sem start; ACK só depois do ID persistido; deadline/desconexão retiram a identidade própria |
| Shutdown/falha de teste podia pular cleanup ou mascarar o erro inicial | `a92a8aec`: aguarda filho, cleanup por operações/tags próprias, etapas independentes e preservação da falha original |
| Wrapper perdeu o exit status físico de --version | `afa2d505`: IPC confiável traz State.ExitCode; versão exige0; fixture stdout válido/exit73 é recusada |
| Reaper e helper competiam pelo mesmo rm; writes IPC podiam chegar depois do retorno | `afa2d505`: stopAndWait aguarda close e drena writes antes do reaper; handlers de rejeição não transformam falha em sucesso |
| Caminho de overflow/erro de stream da versão ainda não aguardava o helper | `7993003d`: finally incondicional do helper e fixture de9000 caracteres |
| VOLUME da imagem criava montagem gravável antes da validação | `0fd3869c`: recusa Config.Volumes antes do create; valida envelope antes de created/ACK/start; separa identidade de ownership da decisão de isolamento; cleanup exato com rm-f-v |
| CLI Docker local usa mensagem de objeto ausente com caixa diferente | `d22fdac3`: somente no-such-object/no-such-container são ausência, sem depender de caixa; demais falhas permanecem incertas. Log negativo anterior preservado |

## Segurança observada no fonte

Spec estrito recusa runner, comando, caminho, transcript e flag `passed` do chamador. O executor deve corresponder ao digest calculado do tipo/imagens. Administração é verificada antes de observar e antes de gravar recibo. As chamadas são fixas e limitadas em tamanho, páginas, modelos e cursor; não há operação de login/inferência nesta interface.

Recibos e pins são imutáveis no PostgreSQL. Promoção exige recibo existente e revisão CAS; revogação usa revisão CAS e sincroniza com a fixação por lock de linha. Uma tentativa nova exige promoção ativa do mesmo tipo/executor/modelo/esforço. Um replay só conserva o recibo antigo se esses campos forem idênticos. Não há conversão de revogação em aprovação para nova tentativa.

Journal085 precede o efeito. O helper confiável cria por imagem exata, verifica isolamento e comunica o ID; só recebe start depois da persistência desse ID. A propriedade de duração depende do host confiável, não da imagem candidata. O cleanup valida ownership e retira por ID; o reaper valida identidade/envelope, mantém incerteza quando a ausência é prematura e inclui tombstones aposentadas para recolher resíduos de create tardio. A admissão global serial usa lock transacional e recusa uma operação nova enquanto existir operação não aposentada. Nenhum PID externo é reciclado como identidade e não há prune global.

## Limites do aceite

Aprova o módulo de confirmação local de **worker/version/app-server initialize/model-list**, o journal/watchdog/reaper e sua prova sintética delimitada. `toolsImage` participa do digest de execução, mas o exec-server da imagem de tools não é observado: não aprova compatibilidade completa do par. As imagens old/new/auth são fixtures, sem elegibilidade ou autenticação oficial.

Os hooks de novos jobs dos supervisores pertencem à revisão de resources/runtime e não recebem aceite implícito deste parecer. Capacity, quota, credenciais, isolamento de execução e elegibilidade continuam gates separados. Falha do daemon/supervisor preserva estado incerto; não se afirma prazo físico garantido com Docker indisponível. A prova anterior de reinícios dos collectors é distinta e não foi aceita em lote nem reexecutada por este reviewer.

Sem conta real, API paga, deploy ou migração operacional. Este parecer não promove RNF13/T26/RF21 ou outros requisitos inteiros e não altera a matriz global.
