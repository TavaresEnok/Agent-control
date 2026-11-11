# Fase 2, passo 0 — levantamento (sem mudança de código)

Data: 11/11/2026. Só leitura do código e deste arquivo. Não rodei o gateway nem a suíte.

O desenho recomendado está na seção 6: **um supervisor de execução e um de planejamento por provedor, compartilhados; o repositório sai do job.** Duplicar o supervisor do mesmo provedor não reparte o trabalho: bloqueia o job novo e, na recuperação, pode operar o job do outro repositório.

## 1. O que está preso a um único projeto

`config.projects[]` já existe (`src/installation.ts:30`) e o `initialize` registra todos (`src/installation.ts:113`). O `serve` só exige que `config.project` esteja no banco (`src/server-main.ts:145-146`). Cada entrada de `projects[]` sobe, mas em `administration-only` (`src/server-main.ts:174-178`).

| Ponto | Onde | Hoje | Por projeto ou comum |
|---|---|---|---|
| Renovar cota e soltar grants mortos | `renewPersonalQuota` e `releaseDeadPersonalGrants` (`src/personal-runtime.ts:24-50`), chamados uma vez em `composePersonalRuntime` (`:74-75`) | Varrem `ac_accounts` e `ac_capacity_grants` da instalação, sem filtro de projeto | Comum. O sweep de grants olha nomes de contêiner globais (`ac-native-plan-`, `ac-native-worker-`, `ac-native-tools-`, `ac-native-qa-` + id do job). |
| Esconder `.ai/` | `src/personal-runtime.ts:77` | Só `config.project.repo` | Por projeto. Cada checkout precisa da mesma linha em `.git/info/exclude`. |
| Chaves, imagens, rede, pastas de conta | `src/personal-runtime.ts:79-84` e o bloco `nativeBootstrap` (`src/native-setup.ts:78-82`) | Uma chave de planejamento, uma de execução, uma de revisão; `hostRoot` e `accountRoot` únicos | Comum. Já é o que a Fase 2 pede. |
| Lista de repositórios protegidos | `src/personal-runtime.ts:85` | `config.project.repo` mais `config.projects[].repo` | Comum, como allowlist. O worker só pode receber um caminho que esteja nela. |
| `NativePlanningSupervisor` | `src/personal-runtime.ts:86-91` | Um por provedor com conta (`id` = `boot.planning.id+'-'+provider`). Não guarda um repositório. | Comum, um por provedor. Dois do mesmo provedor quebram o registro: `SemanticPlanning` recusa a segunda rota `provider@mode` com `PLANNING_EXECUTOR_AMBIGUOUS` (`src/semantic-planning.ts:45`). |
| `NativeExecutionSupervisor` | `src/personal-runtime.ts:93-99` | Um por provedor. `repository` é só `config.project.repo`. | O objeto pode ser comum **se** o repositório passar a vir do job (seção 2). Hoje está preso ao projeto principal. |
| Git, QA, verificação, implementação, engenharia | `src/personal-runtime.ts:102-110` | `PersonalGitArtifacts`, `Quality`, `NativeQa`, `NativeVerification`, `NativeImplementation` e `allowedTargets` usam o repo e o branch HEAD de `config.project` | Por projeto. O branch permitido é o HEAD daquele checkout (`:108-110`). |
| `PersonalManagerChat` | `src/personal-runtime.ts:111`; a classe não guarda repo (`src/personal-manager-chat.ts:40-66`) | Uma instância. O texto do repositório entra em `decide(message, repositoryContext)`. Quem chama usa `this.runtime.repo` (`src/happier.ts:366` e `:466`). A escolha da conta gerente não filtra projeto (`src/personal-manager-chat.ts:43-45`). | A instância pode ser comum. O contexto do repositório tem de ser o do runtime da conversa. As contas são comuns; a cota esgotada também (seção 3). |
| `registerStageReporter` | `src/server-main.ts:158`; função em `src/personal-team-feed.ts:117-127` | Um callback global no processo, com um `repo` só. O diff do programador usa esse repo (`:77`). `teamStatus` lista todos os perfis habilitados, sem projeto (`:92-93`). | O host de execução é comum. O repo do diff tem de ser o do intent. |
| Runtime e transporte | `src/server-main.ts:174-180` | Bootstrap nativo, engenharia, planejamento, execuções, implementação, `semanticPlanning` e `managerChat` só quando `project.id===config.project.id`. Os outros projetos chamam `runtime.start('administration-only')`. | A decisão de executar passa a ser por projeto, sob `activation==='personal'` e bootstrap `active`. Os supervisores continuam os mesmos objetos. |
| Modo de execução | `src/server-main.ts:153-154` e `:178` | `composePersonalRuntime` só se o bootstrap está `active`. `active` com outra ativação é recusado. | A execução personal continua gated. O que muda é não limitar ao `config.project`. |
| `CEZ_SINGLE_PROJECT` | `src/server-main.ts:162` | Já é `'0'`. | Comum. O Cezar não está em modo de um projeto só. |
| Bootstrap nativo | `src/native-bootstrap.ts:32-35`, `:100`, `:216-227`; escrito em `src/native-setup.ts:72-82` | Um `projectId` e um `contextId`. As contas conferidas são as que têm `ac_account_access` nesse projeto. Em `active`, a checagem do gerente dessa conversa é pulada (`src/native-bootstrap.ts:221-223` só corre se `state!=='active'`). | Imagens, chaves e lista de contas: comum. O vínculo a uma conversa só não pode impedir a segunda. `native-setup` publica política de capacidade e de qualidade só de `config.project` (`src/native-setup.ts:84-94`). |
| `personal-connect` | `src/personal-connect.ts:56-92` | Se já existe contexto de `config.project.id`, volta sem criar outra conversa (`:56-57`). Senão cria **uma** máquina (`:64-67`), **uma** sessão com tag `agent-control-`+id do projeto (`:68-72`), **um** contexto e regrava `managerTransport` com um `machineId` e a lista de contextos. O branch do template é o HEAD de `config.project.repo` (`:80-81`). | Conta, token, máquina e cofre: comum. Sessão, contexto, template e política atribuída: por projeto. |
| `personalSay` / `app-key` | `src/personal-connect.ts:103-106` e `:140-149` | `say` acha o contexto de `config.project` e usa o token comum. A chave do app é a da instalação. | `say` precisa de um projeto. A chave continua uma. |
| `account-add` | `src/account-add.ts:54-68` | Cria a conta e o `ac_account_access` só para `config.project.id`. `maxConcurrent:2`. Configura `ac_capacity_config` (id 1) com `programmingLimit:4` e `evaluationLimit:2` se ainda não existe. | A conta é comum. O acesso ao segundo projeto não é criado aqui. Já existe `Capacity.shareAccount` (`src/capacity.ts:103-109`). |
| `scripts/personal-project.mjs` | linhas 5-13 e 46-62 | Cria outra instalação, outro `dataDirectory` e outro banco. `--share-happier` copia a chave e aponta o Happier do dono, mas o banco continua outro. Recusa se o arquivo já pertence a outro repo (`:62`). | Não serve para a Fase 2. O `--add` tem de ser outro caminho, no mesmo `installation.json` e no mesmo `databaseUrl`. |
| `scripts/personal-setup.mjs` | linhas 16-23 | Põe `activation:'personal'`, inicializa (todos os projetos do arquivo) e chama `native-setup`, que volta a olhar só `config.project`. | A ativação é comum. O setup nativo precisa repetir política por projeto. |
| `scripts/personal-happier.mjs` | linhas 10-22 | Um servidor Happier, SQLite em `<dataDirectory>/happier`. Não escolhe projeto. | Comum. |
| `scripts/personal-services.mjs` | linhas 1-2 e 37-39 | Dois serviços por arquivo de instalação. Se existe `happier-shared-from`, sobe só o gateway. | Comum à instalação. Dois projetos não pedem dois Happiers. |
| `scripts/personal-public.mjs` e `scripts/personal-cockpit.mjs` | só exigem `activation==='personal'` (não citam `config.project`) | Não amarram execução a um repo. | Comum. Não sei se o cockpit assume uma conversa na prática: não li a tela além desse gate. |

`startConfiguredManagerTransport` já filtra `managerTransport.contexts` pelo `runtime.projectId` (`src/manager-transport.ts:21` e `:39-43`). Vários contextos no mesmo arquivo são aceitos pelo schema, até 100, com `contextId` único (`src/installation.ts:40-46`). O que não existe é quem preenche o segundo contexto.

## 2. Como os supervisores pegam trabalho

Nenhum deles varre uma fila global. O trabalho chega com um id, a partir do runtime daquele contexto. A reconciliação de recurso também filtra `r.context_id` (`src/native-resource-envelope.ts:151-163`).

### NativePlanningSupervisor

- Lê `ac_semantic_planning_calls` e `ac_native_planning_jobs`, sempre pelo id da chamada e pelo `context_id` (por exemplo `src/native-planning-supervisor.ts:61-62`, `:155-160`, `:218-222`). Não há coluna de projeto nem de repositório nessas tabelas (`db/migrations/048_semantic_planning.sql:1-13`, `db/migrations/050_native_planning_jobs.sql:2-13`).
- Quem escolhe o supervisor é `SemanticPlanning`: um executor ativo por `provider@mode` (`src/semantic-planning.ts:45` e `:93`). A chamada grava `selected_executor_id`.
- O `id` do supervisor é essa chave. A cerca está em `src/native-planning-supervisor.ts:62`, `:226` e `:314` (`PLANNING_CALL_FENCED` / `supervisor_identity` / `PLANNING_CALL_CONFLICT`). O nome do contêiner é `ac-native-plan-`+id da chamada (`:88` e `:99`), não o id do supervisor. O lease é o do gerente (`manager_epoch` / `execution_epoch` no grant e na chamada), não um lease com o nome do supervisor.
- Não monta o repositório. O texto do repo entra pelo chat (`src/happier.ts:366`).

### NativeExecutionSupervisor

- Não escolhe o próximo job. `start` / `reconcile` recebem o pedido (`src/native-execution-supervisor.ts:164-166` e `:514-516`). A tabela é `ac_native_execution_jobs`, com `context_id`, `intent_id`, `account_id`, `executor_digest` e `key_fingerprint`. Não tem projeto, repositório nem id de supervisor (`db/migrations/051_native_execution_jobs.sql:2-27`).
- Na admissão, o filtro de repositório existe: o `repo` de `ac_project_repositories` do projeto do contexto tem de ser `this.config.repository` (`src/native-execution-supervisor.ts:107-108`). Também exige conta, papel, época e cota (`:110-114`).
- O `id` do supervisor vira `scopeId` (`:81`) e, fora do modo pessoal, `adapterId` da elegibilidade (`:158` e `:178`). No modo pessoal a elegibilidade de provedor é pulada (`:176-178`). A recuperação compara `key_fingerprint` e `executor_digest`, não o `id` (`:639`). Contêineres: `ac-native-worker-`+jobId e `ac-native-tools-`+jobId (`:193`). Rede: `ac-native-exec-`+jobId (`:61`). O diretório é `hostRoot/jobId` (`:95`). Nada disso inclui o id do supervisor.
- Quem chama, para o programador, é `NativeImplementation`. Job novo: ficam os supervisores com `supportsAccount`; se não for exatamente um, `NATIVE_PROGRAMMER_EXECUTOR_AMBIGUOUS` (`src/native-implementation.ts:148-149`). A implementação também recusa o intent se o repo do projeto não for o dela (`:41-42`).

### NativeQa

- Tabela `ac_native_qa_jobs`, com `context_id` e sem repositório (`db/migrations/053_native_qa_jobs.sql:1-17`).
- `reconcileContext` lê jobs daquele `context_id` (`src/native-qa.ts:248-254`). `authorize` exige `ac_project_repositories.repo===this.repository` (`:52-53`). O snapshot usa `this.repository` (`:98`). O contêiner é `ac-native-qa-`+id do estágio (`:234`). Não há id de supervisor; a cerca é `contract_digest` / `verifierDigest` (`:260`).

### NativeImplementation

- Não lê uma fila. Recebe o `intent` do grafo. Confere o repo do projeto (`src/native-implementation.ts:41-42`). Reserva capacidade para aquele `contextId` (`:139`). Escolhe o supervisor pela conta (`:148-149`). O materialize e o worktree usam `this.repository` (`:60-65`).

### NativeVerification

- Usa os mesmos `NativeExecutionSupervisor`. Lê o grant e o job por id e `context_id` (`src/native-verification.ts:28-29` e `:51`). Escolhe o supervisor por conta + digest + impressão da chave e exige um só (`:30-32`). Não olha repositório; quem olha é o supervisor, na admissão.

### Dois NativeExecutionSupervisor do mesmo provedor, um por repositório: um pega o job do outro?

**Não, no início de um job novo.** Não há varredura. Se os dois estão na mesma lista e aceitam a mesma conta, `eligible.length!==1` e ninguém cria o job (`src/native-implementation.ts:148-149`). Se só o supervisor do repo certo está na lista, o outro nem é chamado. Se o supervisor errado fosse chamado, `identity` lançaria `NATIVE_EXECUTION_REPOSITORY_MISMATCH` (`src/native-execution-supervisor.ts:107-108`).

**Na recuperação, pode.** `prepareRecovery` e o replay usam `find`, não “exatamente um” (`src/native-implementation.ts:96` e `:128`). Os dois supervisores da mesma instalação compartilhariam imagem e chave (`src/personal-runtime.ts:80-81` e `:97-99`), logo o mesmo `executorDigest` e a mesma `keyFingerprint`. `find` devolve o primeiro. `validateReplay` não confere repositório (`src/native-execution-supervisor.ts:503-505`). `recover` também não (`:639`). Com o mesmo `hostRoot`, o supervisor errado lê o `request.json` do job e `registerArtifact` importa no `this.config.repository` dele (`:598`). Com `hostRoot` separado, `reconcileRegistered` tende a voltar `uncertain` por `ENOENT` (`:266`) e a recuperação para nesse primeiro supervisor, sem tentar o segundo.

O mesmo vale para o planejamento: dois do mesmo provedor nem sobem (`PLANNING_EXECUTOR_AMBIGUOUS`).

### Como o job sabe o repositório

Não sabe por uma coluna. O caminho é:

`ac_native_execution_jobs.context_id` → `ac_contexts.project_id` → `ac_project_repositories.repo`.

Essa tabela tem uma linha por projeto (`project_id` é a chave) e o caminho é único na instalação (`db/migrations/037_project_repositories.sql:2-5`). O intent de engenharia guarda `targetRef` (o branch), não o caminho. `ac_native_task_inputs` guarda o commit base e o `targetRef` (`src/native-implementation.ts:156-160`). O caminho usado no Git é o `repository` configurado no supervisor, não um campo do job.

## 3. Capacidade e cotas

Três camadas, já escritas em `Capacity.reserve` (`src/capacity.ts:249-386`):

1. **Política por projeto.** `ac_policy_revisions` é `(project_id, revision)` (`db/migrations/004_policies_and_capacity.sql:22-24`). O contexto aponta a revisão. O papel precisa estar nessa política e o perfil precisa de `ac_account_access` naquele projeto (`src/capacity.ts:270-286` e `:237`). `native-setup` publica, só para `config.project`, `maxProgrammersPerContext:2` e `maxEvaluatorsPerContext:2` (`src/native-setup.ts:90-94`). O gerente é no máximo 1 por contexto, no código (`src/capacity.ts:305`).
2. **Conta, atravessando projetos.** `max_concurrent` fica em `ac_accounts` (1–128). O `account-add` grava 2 (`src/account-add.ts:63`). A contagem é todo grant `state<>'released'` daquela conta, sem filtrar projeto (`src/capacity.ts:299-304`). A fila do mesmo jeito: o primeiro da conta, em qualquer contexto (`:329-368`).
3. **Teto da instalação.** `ac_capacity_config` é uma linha (`id=1`). Padrão pessoal, se ainda não havia linha: 4 programadores e 2 avaliadores (`src/account-add.ts:57-58`). Também há teto “conta original” (`src/capacity.ts:307-326`). Não li um valor já gravado no banco do IspAgent; não sei se a linha real ainda é 4 e 2.

Cota de uso é da conta, não do projeto. `ac_quota_observations` tem chave `account_id` (`db/migrations/004_policies_and_capacity.sql:15-18`). `exhausted_until` é coluna de `ac_accounts`. `noteProviderExhaustion` grava isso quando o planejamento, a execução ou o chat do gerente vê limite do provedor (`src/native-planning-supervisor.ts:325`, `src/native-execution-supervisor.ts:542`, `src/personal-manager-chat.ts:70-71`). `renewPersonalQuota` refresca toda conta `subscription_cli` que não está esgotada (`src/personal-runtime.ts:24-28`).

**Duas execuções de projetos diferentes na mesma conta Grok.** Competem pelo mesmo `max_concurrent` (2, se ninguém mudou), pelo teto global de programação e pelo `maxProgrammersPerContext` de cada política. Com os números de fábrica, duas podem reservar ao mesmo tempo. A terceira da mesma conta recebe `CAPACITY_BUSY` ou `CAPACITY_QUEUED` (`src/capacity.ts:327-369`). Se uma delas estoura a cota do provedor, `exhausted_until` tira a conta das duas. Não há fila por projeto: a ordem é idade e prioridade do papel, na instalação inteira (`:367-368`). Isso já é o “fila em vez de erro” do plano; não há um limite extra “Fase 2.5” no código.

`ac_account_access` não é concedido ao segundo projeto por `account-add`. Sem `shareAccount`, a política do projeto B não acha o perfil.

## 4. Conversa e Happier

Hoje, por instalação pessoal que passou por `personal-connect`: **uma máquina, um token, um principal, uma sessão, um contexto, um transporte que executa.** Tudo isso de `config.project`.

- A máquina é criada uma vez (`src/personal-connect.ts:64-67`) e o schema guarda um `machineId` só (`src/installation.ts:40`).
- A sessão Happier é uma, tag `agent-control-`+`config.project.id` (`src/personal-connect.ts:68-72`).
- `managerTransport.contexts` recebe um item (`:90`).
- `serve` cria um `ManagerRegistry` por runtime que tenha contexto (`src/manager-transport.ts:21` e `:37-48`). O do projeto principal recebe `semanticPlanning` e `managerChat`. Os outros, se não estão na lista, não ganham registro (`:21`).
- O servidor Happier é um por `dataDirectory` (`scripts/personal-happier.mjs:12-22`). `--share-happier` em `personal-project.mjs` mostra o outro repo como outra conversa **noutro gateway e noutro banco**, não nesta instalação.

`panelEntry` recusa quando o registro não tem exatamente uma conversa rodando (`src/managers.ts:206-212`). O registro é por `projectId` (`src/manager-transport.ts:37`). Uma conversa por projeto, cada uma no seu registro, não cai nessa recusa. Duas conversas no mesmo registro caem.

As rotas `/api/v1/ac/personal/conversation` e `/messages` não leem `projectId` na query nem no corpo. Usam o `runtime` que o gateway já escolheu (`src/api.ts:160-178` e o `personalAccounts` fechado sobre `runtime.projectId` em `src/server-main.ts:187`). A escolha está em `src/projects-api.ts:42-44` e `:57-61`:

- cabeçalho `x-agent-control-project`, senão
- o id em `/api/v1/p/<id>/` quando não é `default`, senão
- `defaultProjectId`, que é `config.project.id` (`src/server-main.ts:191`).

O painel manda o cabeçalho. `agentControlFetch` copia `getApiScope()` para `X-Agent-Control-Project` (`upstream/cezar/packages/web/src/routes/settings/agent-control-fetch.ts:5-8`). A tela Conversa usa esse fetch e não manda `projectId` (`upstream/cezar/packages/web/src/routes/conversa.tsx:99` e `:166`).

Para uma conversa por projeto na mesma conta Happier muda o seguinte, e não muda o `accept`:

- Reusar o segredo, o token, o `machineId` e o cofre.
- Criar outra sessão (outra tag, outro `sessionId`) e outro `ac_contexts`, e acrescentar o item em `contexts`.
- Atribuir a política de capacidade e publicar o template com o branch **daquele** repo (`src/personal-connect.ts:75-81` hoje usa o repo principal).
- Passar o mesmo `SemanticPlanning` e o mesmo `PersonalManagerChat` ao transporte desse runtime, com `runtime.repo` desse projeto. O `accept` continua o de `src/happier.ts` (o plano, decisão 3). Não li uma segunda autoridade.
- `panelEntry` continua “a única conversa deste registro”. O gateway é quem escolhe o registro. Se o cabeçalho e o `/p/<id>/` faltarem, a rota cai no projeto principal. Não sei se toda navegação da Conversa preenche `getApiScope()`; se não preencher, o celular fala com o projeto errado sem erro.

## 5. Banco

As tabelas de trabalho já separam por projeto ou por contexto. Não há uma tabela `ac_*` cuja chave diga “só existe um projeto”.

- Projeto: `ac_projects`, `ac_memberships`, `ac_project_repositories` (um caminho por projeto, caminho único na instalação), `ac_quality_policies`, `ac_policy_revisions`.
- Contexto (a conversa): `ac_contexts.project_id`, `ac_session_links` (uma sessão por contexto), `ac_managers` (um gerente por contexto), `ac_intents`, jobs nativos, grants (`project_id` e `context_id` em `ac_capacity_grants`).
- Uma chamada de planejamento ativa por contexto: `ac_semantic_single_manager_call` (`db/migrations/048_semantic_planning.sql:14-15`). Dois projetos podem planejar ao mesmo tempo.
- Conta comum de propósito: `ac_accounts.resource_identity` único, `ac_quota_observations` por conta, `ac_account_access` liga a conta a cada projeto.

Singletons da instalação, que devem continuar únicos:

- `ac_installation_activation.id=1` (`db/migrations/095_personal_activation.sql:9-13`).
- `ac_installation_identity.singleton` (`db/migrations/016_installation_identity.sql:1`).
- `ac_capacity_config.id=1`.
- `ac_administrative_one_inflight`: no máximo uma operação administrativa `running` ou `uncertain` na instalação inteira (`db/migrations/047_administrative_operations.sql:16`, conferido de novo em `src/administrative-operations.ts:86`). Não é o caminho do programador pessoal. Não sei se o modo pessoal dispara essa operação; não mudei nada para descobrir.

O que supõe um projeto só está no arquivo e no processo, não numa chave do banco: `nativeBootstrap.projectId` / `contextId`, o `repository` do supervisor de execução, o callback único de `registerStageReporter`, e o `personal-connect` que volta cedo quando `config.project` já tem conversa.

Não abri todas as migrações atrás de todo índice único. Os que li e que atravessam projetos são os singletons acima, o caminho de repo único, e as unicidades por grant, sessão ou intent (um job, um grant), que não impedem dois projetos.

## 6. Proposta

Um supervisor por provedor atende vários repositórios com segurança **se** o caminho vier de `ac_project_repositories` do contexto do job e for conferido também na recuperação e no import. Duplicar o supervisor do mesmo provedor é pior: o job novo nem começa, e a recuperação pode importar no repo errado (seção 2). QA, Git e engenharia continuam um objeto por projeto, porque já carregam o checkout e o branch. Eles recebem a lista compartilhada de supervisores.

Passos, nessa ordem. Cada um deixa o IspAgent sozinho ainda funcionando.

1. **Repositório do job no supervisor de execução.** Arquivos: `src/native-execution-supervisor.ts`. Trocar o uso de `config.repository` em `identity` (`:107-108`), no snapshot (`:205`), no diff de revisão (`:217`) e no import (`:598`) pelo `repo` de `ac_project_repositories` do projeto do contexto, e exigir que esse caminho esteja em `protectedRepositories`. A mesma cerca entra em `validateReplay` (`:503-505`) ou em `registerArtifact`, para a recuperação não importar noutro checkout. Risco: o modo `locked` e o fixture sintético também passam por `identity`. Se o repo registrado do projeto for o `repository` configurado, o resultado tem de ser o de hoje. Prova: um job do projeto A continua a integrar em A; um job cujo repo registrado não está na allowlist é recusado antes de criar contêiner.

2. **Compor o runtime por projeto, com os mesmos supervisores.** Arquivos: `src/personal-runtime.ts`, `src/server-main.ts`. `composePersonalRuntime` devolve os supervisores uma vez. Por projeto: `PersonalGitArtifacts`, `Quality`, `NativeQa`, `NativeImplementation`, `NativeVerification`, `allowedTargets` com o HEAD daquele repo, e o `.git/info/exclude`. O laço de `serve` deixa de exigir `project.id===config.project.id` para pendurar isso e para `start('execution')`, só quando `activation==='personal'` e o bootstrap está `active`. Planejamento e execução são as mesmas instâncias. Risco: dois checkouts e um `hostRoot`; o isolamento é o jobId, que já é único. Prova: com um projeto só, o IspAgent ainda executa. Não adicionar o segundo repo neste passo.

3. **QA e implementação continuam por checkout.** Arquivos: os mesmos do passo 2. Não fundir `NativeQa`: o snapshot é `this.repository` (`src/native-qa.ts:98`) e `authorize` recusa o outro repo (`:52-53`). Duplicar o objeto de QA não é duplicar supervisor de provedor. Risco: dois contêineres `ac-native-qa-`+id; o id é o do estágio, único. Prova: o QA do projeto A, diante de um intent cujo repo registrado é B, continua com `NATIVE_QA_SCOPE_MISMATCH`.

4. **Relato da equipe com o repo do intent.** Arquivos: `src/personal-team-feed.ts`, a chamada em `src/server-main.ts:158`. O diff (`:77`) busca o repo por intent → contexto → `ac_project_repositories`. Se não achar, não usa `config.project.repo`. Risco: relato com arquivos do outro projeto. Prova: `stageReport` de um intent de B roda `git diff` em B.

5. **Segunda conversa na mesma conta Happier.** Arquivos: `src/personal-connect.ts`, `src/native-setup.ts`. Para cada projeto sem contexto: criar a sessão, o contexto, o template com o branch daquele repo, `shareAccount` dos perfis já existentes, e uma revisão de política de capacidade e de qualidade. Não criar outra máquina, outro token nem outra chave. Tirar o retorno precoce (`src/personal-connect.ts:56-57`) que ignora os outros projetos. O transporte desse runtime recebe o `SemanticPlanning` e o `PersonalManagerChat` já compostos; o `accept` não ganha caminho novo. Risco: gravar `installation.json` pela metade. Prova: o arquivo fica com um `machineId`, um `tokenFile` e dois itens em `contexts`; cada `ManagerRegistry` tem uma conversa rodando (`panelEntry`).

6. **Não escolher projeto dentro de `panelEntry`.** Arquivos: nenhum, se o passo 5 estiver certo. A Conversa já manda `x-agent-control-project` via `agentControlFetch`. O gateway já despacha. `panelEntry` segue recusando duas conversas no mesmo registro. Risco real: pedido sem cabeçalho e sem `/api/v1/p/<id>/` cai em `config.project` (`src/projects-api.ts:44`). Prova: com o cabeçalho de A, o GET da conversa devolve a sessão de A; com o de B, a de B. Se a prova mostrar que a tela abre sem `getApiScope()`, aí sim um passo pequeno em `src/api.ts` para recusar o personal sem projeto explícito, em vez de cair no principal.

7. **`--add` no módulo que a Fase 3 reutiliza.** Arquivos: um módulo novo chamado por `scripts/personal-project.mjs` (ou ao lado), mais `src/native-setup.ts` / `src/personal-connect.ts` se o passo 5 não tiver extraído a função. Acrescenta o repo a `projects[]`, registra no banco já existente, compartilha as contas, publica as políticas, cria a conversa. Não cria banco, não copia login, não chama o caminho atual de `personal-project.mjs` que recusa outro repo (`:62`). Risco: escrever o JSON de uma instalação que já executa. Prova: o mesmo `databaseUrl` e o mesmo endereço; `/api/v1/projects` lista os dois.

8. **Os dois pedidos ao mesmo tempo.** Sem arquivo novo de produto. Um pedido em cada conversa, mesma conta Claude e mesma conta Grok. A prova de isolamento do plano: o worker de A não escreve em B (a allowlist e o repo resolvido no passo 1). A cota compartilhada já enfileira; não alterar `src/capacity.ts` neste passo.

Não mexer no seletor do Cezar neste desenho: `/api/v1/projects` já lista os projetos (`src/projects-api.ts:51-55`). A migração do IspAgent (backup, `smoke` de lado) é operação do titular, depois destes passos, como o plano diz.

## 7. Riscos para o modo `locked`

O modo `locked` não pode mudar. O que este desenho tem de não fazer:

- Não alargar `runtime.start('execution')` nem `composePersonalRuntime` para `activation!=='personal'`. Hoje isso já é recusado (`src/server-main.ts:153`, `src/native-bootstrap.ts:105` e `:246-247`). O passo 2 tem de repetir o mesmo predicado para **cada** projeto. No `locked`, todos continuam `administration-only`, inclusive o principal.
- `identity` do supervisor de execução corre também no fixture sintético e no caminho que não é pessoal (`src/native-execution-supervisor.ts:99` e `:176-178`). Resolver o repo pelo banco não pode passar a aceitar um caminho que hoje `NATIVE_EXECUTION_REPOSITORY_MISMATCH` recusa, nem deixar de exigir o repo registrado.
- Não alterar o SQL de `Capacity.reserve` nem os tetos. Isso vale para o `locked`. O compartilhamento de conta no pessoal usa `shareAccount`, que já existe.
- Não envolver `GitArtifacts` do modo bloqueado com `PersonalGitArtifacts`. O `read-tree` no checkout do dono é só pessoal (`src/personal-runtime.ts:59-68`).
- Não chamar `renewPersonalQuota`, `releaseDeadPersonalGrants` nem `registerStageReporter` fora de `activation==='personal'`.
- Não mudar `panelEntry` para “adivinhar” a conversa. No `locked` um registro também pode ter mais de um contexto; a recusa é de propósito (`src/managers.ts:206-212`).
- Não usar `src/remote-git.ts` nem `src/remote-development.ts` (decisão 5 do plano). Não tocar o índice `ac_administrative_one_inflight`.
- O bootstrap `configured` / `activation-blocked` continua sem compor adaptadores reais (`src/native-bootstrap.ts:250-253`). O passo 2 não pode tratar `configured` como `active`.

Não sei dizer, sem correr o `locked`, se algum teste de bancada constrói dois supervisores de execução do mesmo provedor de propósito. Pelo código de produção, `composePersonalRuntime` cria um por provedor, e dois ativos do mesmo provedor no planejamento nem constroem.
