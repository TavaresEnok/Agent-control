# F0/G0: candidata à costura PostgreSQL + relay + Temporal

**G0 PENDENTE. Execução física integrada PENDENTE. Revisão independente PENDENTE.**
Esta implementação não reexecuta nem substitui os recibos físicos dos lotes
Temporal/SQL anteriores. Não há F1, homologação, produção ou segundo dispatcher.

`tools/f0/integrated` reutiliza o boot, guard, schema e migrations do harness
SQL. Importa `SessionAdmissionService`, `SessionLaunchRelay`, modelos de
admissão/ledger e **TemporalService de produto**, SDK 1.10.0 e `Workflows::Base`.
O único ajuste no harness SQL seleciona o serviço real quando o entrypoint
integrado define `AdmissionLab::REAL_TEMPORAL=true` antes do import. O default
continua fechado e os nove testes SQL originais não foram alterados.

Sessão, projeto, companhia, estratégia/manifest, autorização e registry são
fronteiras sintéticas declaradas no código; suas linhas estão no PG, mas isso
não prova modelos/callbacks/tenant/credenciais da aplicação completa. O registry
aponta para `Workflows::IntegratedIdleWorkflow < Workflows::Base`, workflow
inerte que valida o input e espera cancelamento. Não cria container nem chama
CLI de agente. Não há transporte Temporal simulado. A costura usa a seam
existente `TemporalService.connection` com clientes SDK conectados ao servidor
local que o próprio supervisor inicia. Describe/cancel passam pelo serviço;
history/listagem usam esse mesmo SDK/servidor.

## Sequência e critérios executáveis

1. Criar schema aleatório **após** verificar socket `/lab-pg`, role
   `f0_admission_lab`, DB `f0_admission_sql`, COMMENT
   `agent-control:F0-G0:admission-sql:disposable:v1` e ausência de endereço TCP.
   Configurações ambientes PG*/DATABASE são recusadas pelo guard existente.
2. Enfileirar e conceder um permit pelo serviço real; persistir snapshot SQL.
3. Executar o relay em processo separado. O observador de `Client#start_workflow`
   delega sempre via `super`, registra chamada/resposta e repropaga
   `WorkflowAlreadyStartedError`. Um wrapper de `TemporalService.start_workflow`
   delega ao serviço real e exige receipt com handle SDK e runID não vazio;
   grava/fsync e usa `Process.exit!(86)` **antes** de retornar ao relay/commit ack.
4. O supervisor independente exige exit86, claim/tentativa1/token SQL, nenhum
   runID/workflowID de ack persistido, execução RUNNING via servidor e uma task
   concluída no histórico. Exige uma única execução no namespace inteiro, um único evento
   started, tipo correto, original runID igual e nenhuma continuação.
5. Reconstruir relay da linha SQL em outro subprocesso durante o lease saudável:
   não pode haver chamada start adicional nem alteração de claim/tentativa/data.
6. Alterar **somente claimed_at** da fixture identificada por id+token+claimed,
   via SQL explícito para três minutos atrás. Isso **não** comprova passagem real
   dos dois minutos do lease. Exigir exatamente uma linha afetada e salvar snapshot.
7. Outro subprocesso reconstrói e reenvia pelo relay real. Exigir duas chamadas
   totais com mesmo workflowID e `REJECT_DUPLICATE`; apenas a primeira aceita,
   segunda com exceção SDK AlreadyStarted e mesmo runID. Exigir ack persistido,
   tentativa2, novo claim token, permit imutável, uma reserva ocupada, nenhuma
   liberação. History/listagem novamente precisam ter a mesma execução/chain.
8. Cancelar pelo serviço real e esperar CANCELED no describe e evento canceled
   no histórico. A reserva SQL permanece ocupada: nenhum cleanup de runtime
   nem liberação é presumido. O ledger real deve continuar **vazio**, pois o
   workflow inerte não executa fases de runtime; qualquer operação fabricada falha.

Os imports conferem `source_location` de serviço, relay, concessão e SDK antes
da instrumentação, recusando substitutos. RunID inventado, bypass do relay,
ausência de histórico/listagem e uma segunda execução falham as verificações.
Instrumentação local complementa os eventos do servidor, não os substitui.
Uma fraude coordenada de todos os arquivos não pode ser autenticada por um
verificador offline; os recibos exigem proveniência da execução e revisão.

## Dependências e preflight no host preparado

O executor desta entrega não dispõe de Ruby/Docker e não instala toolchains.
O guard integrado também exige `server_version_num=150003` antes do schema.
`Gemfile.lock` integrado é cópia **byte a byte** do lock resolvido do recibo SQL
físico `artifacts/admission-lote2-host-20261031/Gemfile.lock.txt`. O boot exige
essa igualdade e `BUNDLE_GEMFILE` integrado com `BUNDLE_FROZEN=true`; não toca
Gemfile/lock raiz nem resolve gems durante execução. Ruby deve ser 4.0.9.

Imagem SQL local preparada:
`sha256:51e6a0811e25f8987d80eaab3fcec28c8c1c11fbaa07995830eca22cb3a5e116`.
PostgreSQL 15.3:
`postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a`.
CLI fornecida `/home/enok/.local/bin/temporal1.9.1`, versão 1.9.1,
SHA256 do manifest Temporal físico anterior:
`712217694cac9f786a72d4b6c876cd15f3dcf1bf31434d9fed6af25242a327a0`.
Qualquer divergência exige investigar o artefato; não substituir pelo hash do
binário divergente para fazer o preflight passar.

Depois da revisão independente, a operação administrativa exata é:

```bash
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-88f319957cc4-g0-relay-temporal-real
bash tools/f0/integrated/host-run.sh 712217694cac9f786a72d4b6c876cd15f3dcf1bf31434d9fed6af25242a327a0
```

Correção da revisão anterior: o ambiente filtrado dos subprocessos preserva
`BUNDLE_FROZEN` recebido pelo supervisor, sem fabricar autorização quando a
variável está ausente ou falsa. O guard do boot permanece fechado. O script
executa `subprocess_boot_test.rb` na imagem preparada antes de criar recursos
PG/Temporal e conserva `subprocess-boot.log`. Esse teste verifica a variável em
um processo real, carrega os dois entrypoints até o retorno do boot real
(interrompendo antes de qualquer conexão/operação de serviço) e exige rejeição
com `BUNDLE_FROZEN=false`. Não prova execução do cenário integrado.

Para validar somente essa regressão na imagem preparada, sem criar serviços:

```bash
cd /home/enok/srv_projetos/worktrees/14v3rrig/task-88f319957cc4-g0-relay-temporal-real
docker run --rm --pull never --network none --security-opt seccomp=unconfined \
  --memory 2g --cpus 2 --pids-limit 512 \
  --mount type=bind,source="$PWD",target=/work,readonly --workdir /work \
  -e BUNDLE_GEMFILE=/work/tools/f0/integrated/Gemfile -e BUNDLE_FROZEN=true \
  sha256:51e6a0811e25f8987d80eaab3fcec28c8c1c11fbaa07995830eca22cb3a5e116 \
  ruby test/f0/integrated/subprocess_boot_test.rb
```

A execução desse teste Ruby na imagem está **PENDENTE** no executor sem Ruby/
Docker; não há alegação de boot validado fisicamente nesta entrega.

O script recusa imagens locais ausentes (`--pull never`) e CLI divergente, não
faz downloads. Cria nomes exclusivos aleatórios, volume/socket novos e PG
novo identificado. PG e runner usam `network none`, sem publicação de portas,
limites de CPU/memória/PIDs e `seccomp=unconfined` como no recibo físico. O SDK
inicia servidor Temporal próprio em `127.0.0.1`, porta efêmera, UI desligada e
namespace/fila exclusivos. Não usa servidor Temporal preexistente. O boot
valida endereço loopback e namespace; somente o supervisor inicia servidor.
SQLite fica em tmpfs externo `/lab-runtime`; CLI é bind somente leitura.
O runner tem teto físico de 240s, seguido de kill após 15s se necessário:
timeout é falha, nunca skip/PASS. Não muda daemon, redes, sysctl ou serviços.

O script captura status e logs antes de remover apenas seus próprios recursos.
Não executar novamente por rotina após verde; investigar falha mantendo recibos.
Se o host for interrompido com SIGKILL, os nomes em `host-*/postgres-container.txt`
e `socket-volume.txt` identificam os recursos para cleanup exclusivo pela gerência;
isso não autoriza remoção de outros laboratórios.

### Alternativa de preparação de dependências (somente se imagem local faltar)

Não é parte do gate e não foi executada pelo worker. Docker20.10 não suporta
`--security-opt` no build; seccomp default pode quebrar apt postinvoke. A
alternativa usada pela gerência é instalar **somente dependências** em contêiner
temporário com rede host para download, sem iniciar serviços, e fazer commit
de imagem de dependências. Exemplo de recipe consistente com o lock integrado:

```bash
docker create --name f0-integrated-deps --network host --security-opt seccomp=unconfined \
  --entrypoint bash ruby@sha256:32fdd19c0a001077d1711f1afa6d8a0ac9d497c4eac20e47ae7e1c7f7a8c49df \
  -lc 'set -e; apt-get update; apt-get install -y --no-install-recommends build-essential libpq-dev; cd /opt/admission; BUNDLE_GEMFILE=/opt/admission/Gemfile BUNDLE_FROZEN=true bundle install'
docker cp tools/f0/integrated f0-integrated-deps:/opt/admission
docker start -a f0-integrated-deps
docker inspect --format '{{.State.ExitCode}}' f0-integrated-deps
```

Exigir exit0; não iniciar PG/Temporal nesse contêiner. Somente a gerência grava
uma imagem candidata de dependências e verifica o bundle sem rede:

```bash
docker commit --change 'ENV BUNDLE_GEMFILE=/opt/admission/Gemfile' --change 'WORKDIR /work' \
  --change 'ENTRYPOINT []' --change 'CMD ["ruby"]' \
  f0-integrated-deps agent-control-f0-integrated-deps:candidate
docker run --rm --network none --security-opt seccomp=unconfined \
  agent-control-f0-integrated-deps:candidate bundle check
docker image inspect --format '{{.Id}}' agent-control-f0-integrated-deps:candidate
```

Exigir bundle check exit0 antes de usar a candidata. A gerência registra
seu novo digest; o script fixa o digest já preparado e **não** seleciona outra
imagem automaticamente. Preservar stdout/lock/hash de preparação antes do
cleanup. Não refazer instalação quando a imagem indicada já existe.

## Retenção e checks

`docs/validation/artifacts/integrated/run-*/` recebe manifest com hashes de
imports/migrations/harness/lock, versões reais, calls JSONL com fsync, snapshots
SQL, histories/listagens JSON antes/depois, logs de worker/relay, scenario,
result e SHA256. As capturas antecedem DROP SCHEMA/shutdown. Em falha conserva
classe/causa e evidência disponível como FAIL; falha de captura/cleanup também
impede PASS. `host-*/` guarda versão/hash CLI, imagens, status, runner/PG logs,
cleanup e hashes antes da remoção dos recursos. História só contém input
sintético de laboratório; não carregar credenciais/manifest de contas reais.
Binários, gems e SQLite não são versionados nem colocados nesses artefatos.

Checks disponíveis no worker:

```bash
python3 -B test/f0/integrated/receipts_test.py
bash -n tools/f0/integrated/host-run.sh
cmp tools/f0/integrated/Gemfile.lock docs/validation/artifacts/admission-lote2-host-20261031/Gemfile.lock.txt
git diff --check
```

Oito testes de consistência/rejeição usam fixtures **sintéticas** em temporário;
não são ensaio integrado. Depois do gate real, conferir recibos capturados:

```bash
python3 -B tools/f0/integrated/verify_receipts.py docs/validation/artifacts/integrated/run-IDENTIFICADOR
```

Ruby/checks de boot precisam da imagem preparada. O parser tree-sitter do check
SQL anterior também não está instalado neste worker. As assinaturas de listagem
foram conferidas no [SDK Ruby 1.10.0 oficial](https://github.com/temporalio/sdk-ruby/blob/v1.10.0/temporalio/lib/temporalio/client.rb)
(query posicional); isso não substitui executar o gate.

Esta fatia não prova todas as entradas habilitadas, agentes/containers,
T28 real, RF55/segurança, recuperação de bytes móveis ou homologação G0.
Os recibos/commits/pausas anteriores permanecem preservados. Revisão deve
ocorrer em sessão independente antes da execução física pela gerência.
