# R3 — devolução controlada de artefato remoto

A ação assinada `project.returnRemoteArtifact` recebe somente projeto, contexto, host, artefato e ref. A assinatura do dispositivo e o papel owner/admin autorizam separadamente o efeito remoto. O servidor deriva commit, árvore, base esperada e repositório de registros imutáveis. Só aceita artefato com integração concluída, recibo com o mesmo commit/árvore e aprovação humana do digest/política/ref exatos. Uma exportação ou materialização `not_reviewed` não satisfaz esse gate.

O helper SSH só escreve repositórios **bare**, projetos/ref explicitamente permitidos em `gitReturnProjects`/`gitReturnRefs`. O bundle limitado a 64 KiB é validado em repositório isolado; `unpack-objects --strict`, identidade commit/árvore, ancestralidade e conectividade são conferidas antes de publicar. `update-ref --stdin` altera a ref por compare-and-swap e cria, na mesma transação, `refs/agent-control/returns/<operationId>` com blob de digest e recibo. Perda de ACK pode ser recuperada pelo mesmo pedido mesmo depois de outro escritor avançar a ref. Replay não reescreve a branch. Outro pedido ou mudança concorrente não é sobrescrito.

A migração aditiva 074 guarda recibo e proveniência imutáveis. `/api/v1/ac/project-admin/remote-return` passa pela autenticação do gateway, verificação da assinatura e autorização de proprietário; GET de administração expõe candidatos e recibos sem paths/chaves. `RemoteReturnConfig` fornece opt-in por hostname e IDs de credenciais; a integração no bootstrap é um pequeno patch coordenado com quota.

## Prova finita

`tests/r3-delivery-return.test.ts`, Node 22.23.3, PostgreSQL exclusivo `ac-r3-delivery-20261105-pg`, banco filho aleatório, container SSH descartável, host key fixada, chaves efêmeras e tmpfs próprio de 64 MiB. O teste exige ambiente e termina com erro se indisponível; não transforma ausência em skip. Teardown tenta cada recurso próprio e preserva falha de limpeza.

| Cenário interno | Verificação |
| --- | --- |
| Origem autorizada | Control assinado, exportação real SSH, materialização real Git |
| Artefato sem integração/aprovação | Recusado antes de qualquer transporte de devolução |
| Assinatura inválida/sessão ausente | 403/401 no caminho público |
| Host/ref cruzado | Recusado antes do transporte |
| Devolução aprovada | Commit/árvore/conteúdo reais no bare remoto |
| ACK perdido depois do CAS | Banco sem recibo; marcador remoto presente |
| Terceiro altera branch após ACK perdido | Retry recupera recibo e preserva a alteração |
| Replay após persistência | Sem novo transporte/escrita |
| Nova operação com base ultrapassada | 409 conservador; branch preservada |
| Replay remoto alterado/ref/hash/árvore/projeto | Recusados sem mudar ref |
| Proveniência | Uma linha imutável; tentativa de UPDATE recusada |
| Objetos Git | `git fsck --strict` externo e leitura dos conteúdos fonte/aprovado |

Limites: a fixture insere o artefato e os registros de integração/aprovação para provar o gate posterior; não afirma execução de modelo, QA ou grafo completo. O SSH usa wrapper RPC fixo que carrega os helpers de produção; a integração do dispatch no worker tem revisão própria. A primeira devolução compara com o commit original da materialização. Uma operação nova depois de a branch avançar exige nova origem/versionamento; não há rebasing automático ou promessa de entregas incrementais sucessivas. Falha genérica do SSH permanece `REMOTE_TRANSPORT_UNCERTAIN` (409), sem falso recibo de sucesso. O marcador é autoridade sob a conta SSH configurada: escritores com acesso administrativo ao bare podem adulterá-lo. Nenhuma instalação, conta, host operacional ou push real foi usado. Esta entrega não promove T25/RF39 a aceito.

O helper limita Git a um thread de pack e janela de 16 MiB, evitando falha de auto-thread dentro do limite de memória. A verificação de conectividade usa `rev-list` para não depender dos subprocessos opcionais de `fsck` sob `RLIMIT_NPROC` já consumido por outros processos do mesmo UID; a prova executa `fsck` externamente sem relaxar limites do helper.

Validação da primeira entrega: `umask 077; PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH AC_TEST_DATABASE_URL=<PG exclusivo> node --import tsx --test tests/r3-delivery-return.test.ts tests/project-admin-api.test.ts tests/project-admin.test.ts`: **4/4, zero skips**, em `docs/validation/evidence/r3-delivery-return-20261105.log`. `npm run typecheck`: exit 0, sem skipLibCheck. Links locais de dependências/dist existentes foram criados somente na worktree e não fazem parte do commit. Um primeiro ensaio com umask 0002 recusou corretamente o diretório 0775 de uma fixture legada; o comando final acima fixa umask 0077.

## Adaptador de desenvolvimento remoto direto

`RemoteDevelopment` prepara repositório privado somente com o grafo do commit autorizado, executa task fixa configurada em Docker via worker SSH de produção e registra artefato por `Capacity`/`Quality.register`. O perfil selecionado pela capacidade precisa mapear explicitamente ao host/task configurados. Workflows nativos mantêm a exigência de mensagem canônica Happier; a bancada usa template `engineering-synthetic-v1` para tarefa determinística explicitamente configurada, sem enfraquecer essa guarda.

A migração 076 liga workspace, origem assinada, implementação/grant/session e snapshot imutáveis. Cada workspace aceita exatamente uma operação escritora para toda sua vida; claim sem journal não permite repetir execução. Manifesto/claim/snapshot ficam fora do único diretório montado no contêiner. O snapshot exige remoção confirmada do grupo Docker e sela commit/árvore antes de exportar; replays usam o commit selado mesmo se um administrador posteriormente mudar HEAD. Arquivos não rastreados não são adicionados. Importação local só transfere objetos verificados e recusa caminhos modificados fora do contrato; não avança HEAD nem branch remota. Nenhuma evidência de QA/review/aprovação é criada por esse adaptador.

`tests/r3-delivery-workspace.test.ts`: **1/1, zero skips**, worker de produção real (sem wrapper RPC), SSH fixado, Docker físico, source preservado, segundo escritor recusado, canário não rastreado ausente do artefato, replay selado após mudança administrativa, grant real liberado após remoção, registro real `Quality` e gate ainda recusando QA ausente. Log `docs/validation/evidence/r3-delivery-workspace-20261105.log`. A fixture reutilizável `tests/fixtures/r3-delivery-lab.ts` fornece contrato NativeQa e opção `requireJudge` ao ensaio posterior independente.

A guarda tardia no efeito de implementação lê elegibilidade/model quota sob lock da conta e mantém o lock durante transporte. Migração 078 é dependência da frente quota. Neste primeiro commit do adaptador, uma recusa tardia anterior ao transporte conserva a reserva e a operação incerta; o refinamento do journal de emissão/no-effect vem em follow-up, sem alegar retry robusto nesse estado. A configuração assinada de ambientes 079 e o ensaio posterior de QA/review/integração são entregas coordenadas separadas.

## Journal de emissão 080

O refinamento remove a limitação anterior da recusa tardia: o binding grava `pending`; o marcador `emitting` é confirmado em transação PostgreSQL independente **antes** de invocar SSH, enquanto a transação externa conserva a autoridade e os locks da conta/perfil. Falha/rollback depois desse ponto não apaga o fato de possível emissão nem autoriza liberação `not_started`.

Uma recusa determinística de quota/eligibilidade antes da emissão só altera `pending` para `no_effect`, grava recibo **local** `controller-preflight` sem commit/log remoto, libera exclusivamente o grant ainda reservado e remove apenas a reserva de transporte nunca emitida. O journal imutável conserva o vínculo operação/workspace/grant/epoch. O mesmo attempt liberado não é reutilizado: é necessário novo intent/workspace/attempt explícito.

`r3-delivery-workspace.test.ts` passou **3/3, zero skips**: caminho físico anterior; quota esgotada pelo serviço depois da reserva e antes do transporte, sem claim/journal remoto; ACK de start perdido após execução remota, marcador durável sobrevivendo rollback, grant conservado, replay com exatamente um start e registro após retirada física. `r3-delivery-emission-20261105.log`; typecheck exit 0 antes das novas alterações independentes de API.

Revisão independente encontrou starvation da pool: oito transações externas poderiam aguardar a nona conexão do mesmo pool. O marcador agora usa `pg.Client` dedicado com timeout de conexão de 3 s e consulta/statement de 5 s, encerrado em `finally`. A contraprova ocupa fisicamente todos os oito slots compartilhados durante o UPDATE do marcador; ele confirma pela conexão dedicada e o transporte de teste falha antes de SSH. O estado permanece conservador `emitting`, sem claim físico. Ensaio final de emissão **4/4, zero skips** no mesmo log.
