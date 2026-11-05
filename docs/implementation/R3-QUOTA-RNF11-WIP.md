# RNF-11 nativo — checkpoint interrompido pelo usuário, NÃO APROVADO

Esta fatia é WIP preservado para retomada. Não integra o conjunto validado de quota/escopos dos commits `a9f4876d`, `a61c728d` e `c5c6ef46`. Nenhum aceite ou ativação operacional é inferido.

O backend opcional `NativeResourceDockerDaemon` e o bridge Python fixo reutilizam a autoridade física compartilhada de `resource_authority.py`. O bridge mantém o lock da autoridade durante admissão/criação/start/stop/remove, usa apenas endpoints Docker fixos e aplica o mesmo CgroupParent e labels em cada grupo nativo. Nomes determinísticos têm UUID de operação derivado de instalação+nome e claim com digest completo do payload. A criação é limitada a nomes plan/worker/tools/qa. Grupos incertos e órfãos continuam contabilizados no ledger host e no pai físico. Timeouts não desfazem admissão incerta. Replay após retirada é recusado antes de gravar nova reserva; remove por ID imutável ausente é idempotente. A fonte não configura daemon/cgroup.

Há hooks opt-in em configurações de planejamento e execução (`resourceEnvelope`) e no último argumento do construtor QA. O envelope contém a configuração previamente provisionada mais `stateRoot` canônico. Sem envelope, os construtores usam o backend anterior. Nenhuma guarda de ativação de provedor real foi alterada.

A migração reservada foi renomeada de 080 para **081_native_resource_admissions.sql**, para não colidir com a frente delivery. Guarda job/grant/context/epoch, autoridade, nomes, stateRoot e nonce antes do RPC. Os estados são waiting/admitted/uncertain/canceled e razões physical_capacity/human_pause/admitted/uncertain/canceled. Batch de worker+tools é reservado junto antes do journal nativo; planejamento/QA usam um grupo. A espera checa grant, autoridade, cancelamento e pausa entre tentativas de recusa física definitiva. Uma configuração que nunca comporta o batch é recusada de imediato.

Cancelamento pede prova ao host sob o lock: nenhum grupo, nenhum claim de create e somente slots sem container com o mesmo token/stateRoot. Só então remove slots, fsync e permite release fenced de grant. Falta de prova preserva incerteza; updates são condicionados ao contexto/intent/grant/epoch. Um trigger e filtros de Cancellations/NativeImplementation impedem release pré-journal sem a prova. `reconcileResourceAdmissions(principal,authority)` está disponível nos supervisores para cancelamento por sucessor, usando nonce persistido.

## Provas e limite exato

Uma versão anterior, apenas do backend direto, passou o teste físico 1/1: dois controladores separados com Capacity/PostgreSQL reais, mesmo pai de CPU/memória/PIDs, throttling real, limite de fork, SIGKILL mantendo grupo/slot, recusa de nova admissão e retirada pelo sucessor. Essa prova não valida a versão posterior de wait/QA/081.

A última execução focal da versão atual **falhou 0/1** com `NATIVE_QA_CONTAINER_MISMATCH`, após acrescentar QA nativo real, cancelamento assinado e pausa/retomada ao ensaio. Log integral preservado em `docs/validation/evidence/r3-native-resource-envelope-WIP-20261105.log`. O contrato QA da fixture usa environment vazio sobre uma imagem com ambiente padrão; precisa ser conferido na retomada, sem assumir que esse é o único defeito. Não houve nova bateria após a ordem de parar.

O typecheck não encontra erros próprios nesta fatia; permanece falhando nas quatro declarações Cezar/Zod da preparação local já descritas em R3-QUOTA. Python bridge passou `py_compile`. Revisão independente levantou problemas reais e orientou as mudanças, mas **não aprovou a entrega final**.

## Pendências para retomada

1. Integrar/revisar a dependência nova `2e98b970` da frente resources, que acrescenta vínculo único de instalação por host. Este worktree tem a dependência antiga `5add3b71` copiada como `48444364`; não executar a prova final com helper antigo. A API privada de slots foi declarada compatível pelo autor, mas não foi reexecutada aqui.
2. Concluir o hook Cezar antes do primeiro Cancellations.reconcile para chamar reconcileResourceAdmissions em todos os supervisores; o autor de histórico foi informado. Os métodos existem, porém esse hook ainda não está neste checkpoint.
3. Reexecutar a prova física atual e investigar QA_CONTAINER_MISMATCH. Adicionar/confirmar contraprovas de admissão estrangeira e epoch vencido, nonce perdido/ACK incerto, cancelamento após SIGKILL e lotes impossíveis.
4. Não afirmar recuperação automática de espera saudável pré-journal após takeover: NativeImplementation atualmente conserva o wait ativo e evita release sem prova; o fluxo combinado deve demonstrar adoção/retomada ou explicitar neutralização. O ensaio combinado da frente flow ainda não rodou com este backend.
5. Conferir falha de preparação depois de reservar slots e antes de create. A retenção é conservadora, porém a liberação/reconciliação desse caso ainda exige fechamento, especialmente QA com journal já presente.
6. Concluir revisão independente e integração antes de tratar 081 como validada. Não aplicar migração operacional.

Os recursos criados por esta frente são descartáveis, nomeados/rotulados e retirados no fechamento. Nenhuma limpeza global de Docker, diretório compartilhado ou instalação preexistente foi autorizada.

## Fechamento de recursos

Após autorização do principal confirmando ausência de outros consumidores, foram removidos o PostgreSQL próprio `09b91af9abc476382af7c1f6f52bcc943aeaeeb01f51288eb3b0d9195187c9ef` com seu volume anônimo e a tag/imagem de quota `ac-r3-quota-fixture:20261105` (`88c00eff97d5...`). Duas imagens intermediárias próprias (`c7657b24...` e `d4a341dc...`) também foram removidas por ID conhecido. Não há contêiner restante com nome `ac-r3-quota*` nem grupo rotulado de autoridade física nesta bancada. O teste RNF11 retirou seus contêineres e anchor novos; cinco arquivos próprios remanescentes de autoridade/reserva/claim foram removidos somente depois de conferir namespace da instalação, UID/modo/nlink e ausência de seus grupos. O diretório de autoridade compartilhado e recursos preexistentes permaneceram intactos. Nenhum processo de teste desta frente continua executando.
