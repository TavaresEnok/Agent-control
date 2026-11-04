# Retirada do escritor native managed — 04/11/2026

Para tarefa de programação managed concluída e materializada, o supervisor valida recibo terminal Ed25519, concessão, tentativa, conta, perfil, sessão, operação, época e posse. Observa os dois contêineres encerrados por ID, imagem, rótulos, horário e código físico do worker; arquiva ambos os logs privados com SHA-256 e fsync. A migração aditiva 064 registra `prepared` antes de remover o par exato. Após confirmar a ausência dos IDs e nomes, registra recibo Ed25519, auditoria e `neutralized` na mesma transação. A cópia permanece vinculada e não pode ser reutilizada por outra intenção. Retomada e repetição conferem assinatura, arquivos e ausência; falhas ou inconsistências bloqueiam.

A ligação cobre apenas programadores managed com resultado bem-sucedido. Falha, cancelamento, trabalho não iniciado, processo do controlador morto entre remoções e recuperação integral do grafo após essa queda continuam pendentes. O código permite reconciliar um diário preparado com membro do par ausente, mas a prova desta rodada injetou perda de resposta, não morte de processo. Não há revisão independente das alterações finais; RF-54 e T34 permanecem parciais e sem aceite.

## Evidência e limites

- `continuation-native-retirement-physical-fencing-20261104.log`: exit 0, um teste sem skips. Compose isolado `ac-continuation-nativepair-20261104`, Node 22.23.3, PostgreSQL e Git reais. Para cada tarefa, dois contêineres Docker sintéticos reais, sem rede, mounts, socket ou credenciais; a fixture inspecionou as restrições. Após remoção real do primeiro contêiner foi injetada perda de ACK; a repetição removeu o restante, preservou logs, verificou assinaturas e ausência dos IDs. Outra época recusou o gerente antigo e repetiu a confirmação sem duplicar auditoria. O grafo passou com três tarefas, QA substituto e revisão sintética.
- A fixture substitui `NativeExecutionSupervisor.start` e produz o artefato: não prova bootstrap real do supervisor, execução de modelo ou uso real do par para escrever na worktree. Não houve inferência, conta real, migração ou publicação. Banco e arquivos sintéticos permanecem isolados em `.state`.
- `continuation-native-retirement-corrections-final-20261104.log`: exit 0, dois testes sem skips, correções e limite com PostgreSQL/Git reais e Docker simulado. Mensagens `fatal` de caminhos ausentes pertencem às verificações negativas do teste.
- `continuation-native-retirement-fencing-typecheck-20261104.log`: `npm run typecheck`, exit 0, Node do host 24.22.1. Os logs anteriores desta rodada permanecem preservados.

Reprodução da prova física, com banco da bancada já iniciado e imagem sintética presente:

```sh
AC_LAB_UID=1000 AC_LAB_GID=1000 AC_LAB_DOCKER_GID=131 docker compose -p ac-continuation-nativepair-20261104 -f deploy/compose.lab.yml --profile native-dispatch run --rm --no-deps -e AC_NATIVE_RETIREMENT_PHYSICAL=1 -e AC_NATIVE_RETIREMENT_ACK_LOST=1 -e AC_NATIVE_RETIREMENT_ROOT=/home/app/projects/agent-control-implementation/.state/native-dispatch-physical native-dispatch-controller-proof node --import tsx --test --test-name-pattern='QA authorization valid' tests/native-multitask.test.ts
```

A prova de correções usou `docker compose -p ac-continuation-20261104 -f deploy/compose.lab.yml exec -T runtime node --import tsx --test tests/native-corrections.test.ts`. O socket é acessível somente ao controlador da bancada, nunca aos contêineres trabalhadores.
