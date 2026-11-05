# R4 — executar, inspecionar e retomar a bancada

Este roteiro descreve o código integrado, lido a partir de `29ef3513`, e usa somente recursos novos de laboratório. O checkpoint final deve registrar o HEAD efetivamente validado. O stack é Cezar/cockpit + Happier canônico/E2EE + PostgreSQL do controlador; Happier light usa seu próprio SQLite. Não existe comando de instalação que habilite inferência operacional automaticamente.

## 1. Escolher o percurso

| Percurso | Entrada existente | Resultado delimitado |
| --- | --- | --- |
| Administração configurada | `npm run gateway -- initialize/inspect/serve <installation.json>` | Cadastro/migração explícita do banco novo; depois cockpit e administração. `serve` não migra. |
| Transporte de conversa configurado | `managerTransport` + vault autorizado/importado | Conexão/heartbeat/configuração tipada assinada; `transportOnly:true`, sem despacho de trabalho. |
| Fluxo executável de bancada | `node scripts/r3-flow-isolated.mjs` | Cezar, Happier e PG reais, workers/QA/revisão determinísticos, Git e fencing físicos; substitutos explícitos, não conta oficial. |
| Importação/exportação focal | `npm run test:isolated` | Happier light/PG novos, histórico canônico cifrado e CLI. Não executa a suíte inteira. |

`npm start` e `npm run start:built` chamam **lab-main**, dependente da fixture `.state`; não substituem o bootstrap configurado. `nativeBootstrap` omitido/disabled não cria adaptadores. O modo configured continua `activation-blocked`; bench exige injeção de código e é recusado por `serve`. Não converter esses estados em autorização para remover guards de contas ou editar grants incertos.

## 2. Pré-requisitos e builds

Trabalhe em checkout/worktree próprio e confira `git status --short`, `git rev-parse HEAD`, `git worktree list` antes de preparar dependências. Preserve arquivos locais preexistentes. Use Node **22.23.3** (engines: >=22.23.3 <23), Git, Yarn1.22.22 e PostgreSQL16. Docker/Compose, Ruby e imagens locais são necessários somente às bancadas físicas indicadas. Confirme o interpretador antes de qualquer comando:

```sh
export PATH=/CAMINHO/node-v22.23.3-linux-x64/bin:$PATH
node --version
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix upstream/cezar ci --ignore-scripts --no-audit --no-fund
npm --prefix upstream/cezar run build:server
VITE_AGENT_CONTROL_MANAGED=1 npm --prefix upstream/cezar run build:web
```

O cockpit servido pelo gateway vem de `upstream/cezar/packages/cezar/web/dist`; o flag managed deve estar no build. `build:server` não produz esse web bundle. Não construir sobre `dist` compartilhado por symlink de outra frente: use artefatos locais próprios ou uma cópia de proveniência conferida. Execute builds pesados/Expo/provas físicas em série, pois concorrência já causou pressão de memória nesta bancada.

Happier precisa do workspace completo instalado com seu lockfile, dependências compartilhadas compiladas, cliente Prisma SQLite gerado e boundary Agent Control. A receita existente está em [LAB](../operations/LAB.md), [R2-HARNESS](R2-HARNESS.md) e `deploy/Dockerfile.lab`; não tratar apenas `.agent-control-boundary.mjs` como instalação do servidor. No workspace preparado:

```sh
# Executar no checkout raiz, depois de instalar o workspace Happier fixado.
node upstream/happier/apps/server/scripts/buildSharedDeps.mjs
(cd upstream/happier/apps/server && yarn -s generate:providers)
node scripts/build-happier-boundary.mjs
npm run typecheck
npm run build
```

Para reaproveitar **somente** dependências já existentes e correspondentes às fontes, sem baixar nem sobrescrever entradas, há o helper reversível abaixo. O cache `/tmp/ac-close-base` é específico desta máquina e pode desaparecer; não é distribuição autossuficiente.

```sh
mkdir -p upstream/happier/node_modules/@happier-dev
node scripts/link-happier-test-deps.mjs install /tmp/ac-close-base/upstream/happier /tmp/MEU-ID-happier-links.json
# Ao terminar, só remover os links registrados e ainda iguais:
node scripts/link-happier-test-deps.mjs remove /tmp/MEU-ID-happier-links.json
```

A UI Happier canônica é outro build. A receita Expo integral está em LAB; use `EXPO_PUBLIC_HAPPIER_SERVER_URL` da bancada, `EXPO_OFFLINE=1`, um worker e heap explícito conforme essa receita. Confira fonte/hash do export reutilizado; um bundle de outra versão não prova a alteração atual. `node scripts/serve-happier-web.mjs` serve o dist canônico existente **somente em127.0.0.1:18400**, sem opção de porta. Não há chat substituto neste roteiro.

## 3. Laboratório manual novo, sem tocar serviços existentes

Os exemplos seguintes são Bash. As portas18400/18401/18405 são do roteiro histórico; prossiga somente se estiverem livres. Se houver serviço preexistente nelas, preserve-o e use o runner isolado de portas efêmeras da seção6. Nenhum comando abaixo foi executado para redigir este documento.

```sh
umask 077
taskLabRoot=$(mktemp -d /tmp/ac-r4-manual.XXXXXXXX)
taskLabName="ac-r4-manual-$(date +%Y%m%d%H%M%S)-$$"
mkdir -p "$taskLabRoot/projects/demo/src" "$taskLabRoot/private" "$taskLabRoot/happier" "$taskLabRoot/happier-home"
git -C "$taskLabRoot/projects/demo" init -b main
printf 'laboratorio\n' > "$taskLabRoot/projects/demo/src/example.txt"
git -C "$taskLabRoot/projects/demo" add src/example.txt
git -C "$taskLabRoot/projects/demo" -c user.name=Laboratorio -c user.email=lab@example.invalid commit -m 'Fonte sintetica'
git -C "$taskLabRoot/projects/demo" branch protected
# Imagem local; porta loopback efêmera e dados descartáveis próprios.
taskPgId=$(docker run -d --pull=never --name "$taskLabName" --label agent-control.disposable=r4-manual --label agent-control.owner="$taskLabName" --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m -e POSTGRES_PASSWORD=synthetic-runbook-only -e POSTGRES_DB=ac_implementation_test -p 127.0.0.1::5432 postgres:16-alpine)
docker port "$taskPgId" 5432
docker exec "$taskPgId" pg_isready -U postgres
```

Registre nome, ID completo, labels e porta retornada. A senha acima é exclusivamente sintética desse contêiner novo; não reutilizá-la em instalação operacional. O schema do controlador será aplicado somente por `initialize` ao URL privado desse banco novo.

Para Happier light persistir **apenas nessa área**, em um terminal próprio, use as variáveis já utilizadas pelas fixtures. O ambiente/HOME abaixo pertence ao processo filho; não altera o HOME do shell ou de outros serviços:

```sh
# taskLabRoot precisa ser o mesmo diretório novo criado acima.
taskHappierEnv=(env -i "PATH=$PATH" "HOME=$taskLabRoot/happier-home" LANG=C.UTF-8 TZ=UTC DOTENV_CONFIG_PATH=/dev/null CI=1 DO_NOT_TRACK=1 EXPO_NO_TELEMETRY=1 PORT=18401 METRICS_ENABLED=false AUTH_ANONYMOUS_SIGNUP_ENABLED=true HAPPIER_FILES_BACKEND=local HAPPIER_DB_PROVIDER=sqlite HAPPY_DB_PROVIDER=sqlite "HAPPIER_SERVER_LIGHT_DATA_DIR=$taskLabRoot/happier" HAPPIER_SERVER_HOST=127.0.0.1 HAPPY_SERVER_HOST=127.0.0.1 "DATABASE_URL=file:$taskLabRoot/happier/server.sqlite?socket_timeout=30&connection_limit=1" HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=required_e2ee)
(cd upstream/happier/apps/server && "${taskHappierEnv[@]}" yarn -s migrate:sqlite:deploy && "${taskHappierEnv[@]}" yarn -s start:light)
```

Esse migrate afeta somente o SQLite novo indicado. Um GET sem credencial a `http://127.0.0.1:18401/v1/account/profile` deve ser401; isso prova listener/autenticação, não execução de IA. Abra a UI Happier exportada em outro terminal com `node scripts/serve-happier-web.mjs`. Crie/pareie somente a identidade descartável local e obtenha seu `id` pela resposta autenticada real de `/v1/account/profile`. O `owner` da instalação é esse ID; não é e-mail, dispositivo inventado nem token. Tokens e chaves ficam em arquivos privados fora dos repositórios; não copiar para comandos registrados, Git ou chat.

## 4. Descriptor administrativo e comandos

Crie `installation.json` em `$taskLabRoot/private`, modo0600, owner igual ao usuário do processo, sem symlink/hardlink. Substitua o prefixo ilustrativo pelos caminhos **canônicos reais** e18532 pela porta PG retornada. O exemplo abaixo passou pelo schema atual `Installation`; seus placeholders não são uma identidade ou instalação já pronta:

```json
{
  "schemaVersion": 1,
  "mode": "administration-only",
  "databaseUrl": "postgresql://postgres:synthetic-runbook-only@127.0.0.1:18532/ac_implementation_test",
  "dataDirectory": "/tmp/AC_RUNBOOK_LAB/private/state",
  "projectRoots": [{"id": "lab", "label": "Laboratorio novo", "path": "/tmp/AC_RUNBOOK_LAB/projects"}],
  "project": {"id": "10000000-0000-4000-8000-000000000001", "label": "Projeto de laboratorio", "repo": "/tmp/AC_RUNBOOK_LAB/projects/demo", "owner": "REPLACE_WITH_VERIFIED_LOCAL_HAPPIER_ID"},
  "projects": [],
  "nativeBootstrap": {"state": "disabled"},
  "codexQuota": {"state": "disabled"},
  "http": {"listen": "127.0.0.1", "port": 18405, "publicOrigin": "http://127.0.0.1:18405"},
  "happier": {"upstreamOrigin": "http://127.0.0.1:18401", "webOrigin": "http://127.0.0.1:18400", "publicServerOrigin": "http://127.0.0.1:18401"},
  "sessionMaxAgeSeconds": 3600
}
```

Raízes/repos/.git devem pertencer ao usuário e não ser graváveis por grupo/outros; paths autorizados recusam symlink. O diretório privado é externo ao repo e à raiz de projetos. A origem HTTP é permitida apenas em loopback. Acesso remoto/HTTPS/proxy é uma implantação distinta, ausente deste roteiro.

Execute na raiz do checkout preparado, mantendo o mesmo arquivo privado:

```sh
npm run gateway -- inspect /CAMINHO/PRIVADO/installation.json
# Aplicar migrações e cadastro SOMENTE ao PostgreSQL descartável novo escolhido.
npm run gateway -- initialize /CAMINHO/PRIVADO/installation.json
npm run gateway -- inspect /CAMINHO/PRIVADO/installation.json
npm run gateway -- operator-bootstrap /CAMINHO/PRIVADO/installation.json
npm run gateway -- serve /CAMINHO/PRIVADO/installation.json
```

`inspect` é read-only: exit0 somente para checks pontualmente `ok`; exit2 quando houver blocked/unknown e exit1 para configuração/arquivo inválido. Antes de initialize é normal haver pendência. `initialize` cria schema/registros/chave de browser; **não apontá-lo a banco operacional/preexistente**. `serve` exige registros/chave existentes e não aplica migrações. A saída esperada é `administration_ready`, `executionEnabled:false`, `inferenceEnabled:false`.

`operator-bootstrap` devolve só o caminho de um código privado válido por10minutos. Leia-o em terminal privado e use o fluxo de cadastro do dispositivo no painel; não postar o conteúdo em chat/log. Login usa o pareamento Happier e cookie do gateway. Controles tipados exigem prova humana Ed25519, ACL e Origin; sessão/bearer do gerente não substitui essa prova. Em Settings → Agent Control, configure ambientes assinados somente depois de registrar repo/branches/diretórios existentes. O formulário escolhe fonte/ref/diretórios e destinos; uma revisão nova não substitui efeitos físicos ou journals incertos em andamento.

## 5. Opt-ins de transporte e desenvolvimento remoto

O schema único é [installation.ts](../../src/installation.ts); consulte também [BOOTSTRAP-OPERACAO](BOOTSTRAP-OPERACAO.md), [manager transport](CONFIGURED-MANAGER-TRANSPORT-20261102.md) e [native bootstrap](NATIVE-BOOTSTRAP-20261103.md). Não inventar campos de execução nem preencher JSON para contornar a capacidade de bancada não serializável.

- `managerTransport` exige `contextVault`, tokenFile privado/canônico, identidade Happier verificada e contextos/chaves autorizados/importados. `vault-initialize`, `context-key-authorize` e `context-key-import` são comandos separados com descriptors privados segundo `context-vault-cli.ts`. Uma sessão vinculada no painel não concede automaticamente custódia da chave ao gerente. O registry revalida época/instância/lease; transporte conectado não significa modelo ativo.
- `remoteReturn` é opt-in de transporte SSH, com allowlist de hosts e `{id,path}` de credencial privada. O caminho da credencial deve estar fora dos repos/raízes autorizadas; fingerprint/registro do host e CAS/ref/artefato continuam obrigatórios.
- `remoteDevelopment.mode` aceita somente `synthetic-fixed-task-v1`. Cada projeto declara `verifierKeyFile` privado canônico de32bytes, `tmpfsRoot` separado e bindings `{profileId,hostId,taskId,writePaths}`. O registry resolve autoridade viva do contexto; absence de binding/manager não vira fallback. O perfil restringe os caminhos;079 exige ambiente/target/destino e scope imutável da tarefa fixa. Preparar workspace/produzir artefato não semeia QA ou aprovação.

Os formatos completos desses opt-ins estão em `remote-return-config.ts` e `remote-development-config.ts`; não publicar key/token/config em exemplo de Git. Usar apenas identidades sintéticas e hosts novos de laboratório. O bootstrap administrativo não habilita contas reais/API/inferência. As provas de desenvolvimento físico por fixture são entradas explícitas separadas.

## 6. Provas já existentes e comandos exatos

Escolha uma prova pelo delta que precisa verificar; não iniciar todas simultaneamente. Os runners que criam serviços imprimem identidades próprias e falham quando há skips/cleanup incompleto. Um teste focal verde não homologa os111requisitos.

```sh
# Happier/PG novos + importação e CLI; imagem postgres:16-alpine deve ser local.
npm run test:isolated
# Somente a prova canônica do CLI, com151mensagens; não substitui a seleção completa.
AC_ISOLATED_EXPORT_ONLY=1 npm run test:isolated
# Recuperação canônica/vault/PG em cópias descartáveis próprias.
node scripts/r3-recovery-isolated.mjs
```

Fluxo físico determinístico: leia [R3-FLOW](R3-FLOW.md) e o estado R4 antes de executar. Exige Docker/Compose, Ruby, imagens locais e ELF público Codex0.166.0 com hash pinado; não usa login/inferência oficial. O runner integrado atual recebe os hooks de ambiente/recursos/continuidade do HEAD e ainda precisa do respectivo parecer final:

```sh
AC_R3_FLOW_PUBLIC_CODEX_BINARY=/CAMINHO/ABSOLUTO/codex \
AC_R3_FLOW_PUBLIC_CODEX_SHA256=b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8 \
node scripts/r3-flow-isolated.mjs
```

Para testes que exigem base PG própria, use `AC_TEST_DATABASE_URL` cujo banco seja exatamente `ac_implementation_test` em127.0.0.1/localhost/db; `isolatedDatabase` cria/remove um nome aleatório por teste. Não apontar a instância antiga de outro agente. `tests/r3-project-environments.test.ts` tem guard separado `AC_R3_ENVIRONMENTS_DATABASE_URL` com `/ac_r3_environments`;079 alterada antes da entrega exige banco novo, não reaproveitar histórico de checksum incompatível. Evidência CLI/notificações v2 e limite de60s estão em `R4-NOTIFICATIONS-CLI.md`; export metadata/backend em `R4-PORTABLE-EXPORT.md`. Não considerar esses arquivos como restauração operacional.

## 7. Encerrar e retomar

Para gateway/Happier iniciados em primeiro plano neste roteiro, use SIGINT/SIGTERM no terminal/processo próprio. `serve` fecha registry, runtime, bootstrap e pool; `INSTALLATION_SHUTDOWN_FAILED`/exit1 significa limpeza incompleta. Não matar processos por nome global nem remover worker/grant incerto para fabricar sucesso.

Antes de remover o PostgreSQL manual, confira ID+labels contra o registro feito na criação. Só então remova **esse ID**; os dados desse banco são deliberadamente tmpfs e descartáveis. Se quiser retomar seus dados, preserve o contêiner/área ou faça o backup de laboratório documentado, em vez de executar a remoção.

```sh
docker inspect --format '{{.Id}} {{json .Config.Labels}}' "$taskPgId"
# Somente depois de conferir o ID e ambos os labels desta rodada:
docker rm -f "$taskPgId"
```

Não executar prune global, `down -v` em projeto preexistente, remover worktrees de terceiros, resetar o checkout, alterar Paseo ou limpar `.state` compartilhado. Remova os links somente pelo manifesto e diretórios novos somente pela identidade anotada. Fechar a bancada não requer apagar código, chaves ou histórico.

Checkpoint de retomada: registrar branch/HEAD completo, status local, refs/WIPs não integrados, logs de cada teste com versão/proveniência, IDs/labels dos recursos restantes, paths dos arquivos privados **sem seus conteúdos**, critérios ainda pendentes e quem revisou cada fatia. Leia `CONTINUACAO-R4-20261105.md`, os pareceres R4 e o próximo manifesto STOP se houver. Não assumir que `/tmp`, caches, contêineres ou leases anteriores sobreviveram. Reconcilie efeitos incertos sob a autoridade corrente; não reexecutar cegamente o último comando. A próxima sessão deve continuar a lista literal de pendências, preservando distinção entre implementação local, prova sintética, prova física, revisão independente e homologação operacional.

## Validação deste documento

Comandos/flags e formatos foram conferidos no código atual e nos runbooks citados. O exemplo Installation e os demais blocos JSON foram validados sem conexão a banco; arquivos de validação foram criados0600 em área nova e removidos. Blocos Bash passaram em `bash -n`. Não se abriu gateway, Happier, PostgreSQL, browser ou modelo para escrever este roteiro; ele não é prova de instalação nova em outra VM. Logs de validação sintática constam em `docs/validation/evidence/r4-runbook-syntax.log`.
