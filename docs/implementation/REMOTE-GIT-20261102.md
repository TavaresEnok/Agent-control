# RF-51 — exportação Git por SSH em bancada

`RemoteOperations.exportGit` exige proprietário do projeto e autoriza contexto, intenção ativa,
gerente e host cadastrado; exige `git-export` na whitelist do host. A operação
é somente leitura na origem, mas ainda é auditada e sua identidade é guardada
em `ac_remote_operations`. Um replay da mesma identidade compara o hash; uma
mudança de identidade para o mesmo operationId é recusada. Um erro antes do
commit local deixa a exportação sem recibo; nova tentativa é leitura, não uma
inferência de que houve escrita remota.

O `OpenSshTransport` existente confere a chave e fingerprint cadastrados e
chama o worker fixo. Sua nova ação estrita `git-export` chama somente
`/usr/local/lib/agent-control/remote_git.py`, montado read-only no compose da
bancada. O helper escolhe o repositório pelo projeto configurado no host; o
pedido não aceita caminho nem comando. O projeto também precisa constar na
lista explícita `gitExportProjects` do host, ausente por padrão. Ele exige commit e tree completos,
verifica ambos, gera bundle autocontido com apenas objetos alcançáveis pelo
commit, limita o resultado a 65536 bytes e devolve SHA-256. A origem não
recebe credenciais de IA, remoto Git, alteração de refs ou push.

`RemoteGitMaterializer` confere o bundle com Git e verifica commit e tree em um
repositório bare novo sob uma raiz privada, canônica, pertencente ao processo e
localizada em tmpfs de até 128 MiB. Git é executado em grupo próprio com limite
de memória, CPU e tamanho de arquivo; timeout encerra o grupo. O helper remoto
aplica limites ao empacotamento. A capacidade tmpfs limita o uso agregado do
filesystem, que pode ser compartilhado com outros processos. O chamador deve
passar o resultado de `exportGit`; o destino é publicado por rename depois de
validado sob lock exclusivo por operationId. Lock preexistente é recusado; após
crash requer reconciliação manual. Replay aceita destino existente apenas com a
mesma identidade. O proprietário pode ler qualquer OID disponível no projeto
autorizado do host; commit/tree não estão vinculados ao payload da intenção ou a
um artefato anterior. A materialização é uma primitiva local: ainda não há vínculo de
produto com cadastro de projeto, interface ou execução gerenciada automática.
O limite de 64 KiB é explícito e exclui projetos maiores nesta primeira fatia;
nenhuma inferência de prontidão geral de RF-51 decorre desta prova.

## Vínculo com a intenção original

O vínculo hoje comprovável é operacional: `ac_remote_operations.intent_id`
referencia uma intenção no mesmo contexto, o controlador exige que ela esteja
ativa e o `request_digest` da exportação cobre intenção, host, contexto, commit
e tree. O recibo de exportação e seu replay conferem esses identificadores e o
hash do bundle. Isso comprova qual pedido de leitura foi associado à intenção;
**não comprova que a intenção original pediu ou aprovou aquele commit/tree**.

O `Command` atual é estrito: seu payload contém `workflow`, `messageRef` e,
para plano gerenciado, revisão e digest da proposta; não contém uma identidade
tipada de fonte Git. `messageRef` é referência opaca (no Happier, localId e
digest do texto), não um compromisso verificável com commit/tree. O digest da
intenção salvo pelo ledger identifica o comando sem a tentativa de entrega; não
é assinatura digital nem introduz os dados que faltam. A prova de operador
existente se aplica ao comando de controle submetido àquela fronteira, não deve
ser presumida para todo caminho de criação de intenção. Não se deve reinterpretar
`messageRef`, um `inputRef` livre do plano ou o digest do pedido posterior como
autorização original de um snapshot específico.

Para obter esse vínculo sem ambiguidade seria necessário um contrato autenticado
versionado, anterior à exportação, que cubra pelo menos projeto, host, commit,
tree e intenção/contexto, com domínio e regras explícitas de replay. A
persistência teria de preservar a evidência verificável dessa autorização e a
exportação teria de compará-la antes de aceitar a fonte. A forma de transporte,
versão, política para intenções antigas e eventual migração ainda precisam de
decisão própria. Nenhum desses mecanismos foi criado nesta rodada; um snapshot
continua `not_reviewed` e não dá permissão de integração.

## Evidência local

Após a revisão de segurança, `docker compose -f deploy/compose.lab.yml exec -T
-e AC_REMOTE_GIT_IDENTITIES=… ssh-controller node --import tsx --test
tests/remote-git.test.ts` retornou exit 0, três testes sem skips; registro
`docs/validation/evidence/remote-git-hardening-final-20261102.log`. Cobre
blob de 20 MiB altamente compressível, raiz com modo inseguro, symlink,
concorrência no lock, whitelist, owner, PG descartável e ambos hosts SSH. Os
limites são AS 512 MiB, CPU 8 s, arquivo 32 MiB local/64 KiB no export remoto,
NPROC 1024 por UID e timeout 15 s. O comando fixo desabilita manutenção Git
automática. Python 3 em `/usr/bin/python3` e tmpfs adequado são obrigatórios;
a imagem runtime comum da bancada não inclui Python. NPROC é por UID e pode
competir com processos do mesmo usuário. A finalização de descendentes em
timeout e a exaustão de CPU/memória não foram demonstradas. Um lock deixado por
crash permanece bloqueado até intervenção segura. Logs diagnósticos negativos
anteriores foram preservados: tmpfs de 8 GiB rejeitado, ausência de Python na
imagem runtime e NPROC 32 impedindo fork com UID compartilhado.

Os registros seguintes são da versão anterior ao hardening:

- `node --import tsx --test --test-name-pattern='bounded configured' tests/remote-git.test.ts`
  exit 0; `docs/validation/evidence/remote-git-unit-whitelist-20261102.log`.
  Inclui whitelist ausente, bundle inválido, hash/tree divergente, campo extra, tamanho excessivo
  e replay local.
- `docker compose -f deploy/compose.lab.yml exec -T runtime node --import tsx --test --test-name-pattern='remote export is bound' tests/remote-git.test.ts`
  exit 0; `docs/validation/evidence/remote-git-pg-first-20261102.log`. O fixture
  criou e descartou banco novo; cobre autorização, pausa, conflito e auditoria.
- Com `AC_REMOTE_GIT_IDENTITIES` contendo os commits e trees sintéticos obtidos
  dos dois hosts, `docker compose -f deploy/compose.lab.yml exec -T -e AC_REMOTE_GIT_IDENTITIES=… ssh-controller node --import tsx --test --test-name-pattern='two pinned SSH fixture' tests/remote-git.test.ts`
  exit 0; `docs/validation/evidence/remote-git-ssh-whitelist-20261102.log`. Os dois
  hosts usaram o commit `2bca7775fbb6d954c2f24f958298c1b109ab22dc` e tree
  `96ad38b351ff17d4020bd71178c05eac945caa26`, criados exclusivamente nas
  fixtures, com um arquivo sintético; cada export foi repetido e materializado.
- `npm run typecheck` executado durante edição concorrente retornou exit 1 em
  `src/project-admin-api.ts` linhas 15 e 17, por status 413 incompatível com a
  união de `Refusal`. A falha foi comunicada à frente proprietária; não é
  evidência de sucesso do typecheck integrado.

Não foi testado servidor SSH operacional, repositório grande, interrupção no
meio de transferência real ou integração do materializador ao fluxo de produto.
O limite de 64 KiB e a disponibilidade de `git`/Python no host são restrições
atuais. Não houve conta real, inferência, GitHub, push, migração ou publicação.
