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
