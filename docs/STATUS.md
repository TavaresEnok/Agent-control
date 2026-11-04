# Agent Control — estado atual de implementação

## Continuação vigente: retirada native managed — 04/11/2026

O supervisor agora arquiva os logs e retira o par de contêineres de programador managed concluído após validar recibo e vínculos; diário preparado, prova Ed25519 e fencing preservam a confirmação. Uma prova com pares Docker sintéticos reais cobriu perda de ACK e troca de gerente, mas usa fixture para o lançamento e o artefato. Falha/cancelamento, morte do controlador entre remoções e agentes reais continuam pendentes. Revisão independente é condição de promoção. RF-54 e T34 seguem parciais e sem aceite. Detalhes em `implementation/NATIVE-WRITER-RETIREMENT-20261104.md`.

## Continuação vigente: dispensa de QA e worktree — 04/11/2026

A retirada do escritor managed sintético concluído foi ligada ao broker: log preservado, diário `prepared`, remoção/ausência física e recibo HMAC precedem `neutralized`. O registro de cópia permanece imutável e sem reuso. Falha/cancelamento e execução native continuam bloqueados; queda de broker exige reconciliação e não retomou automaticamente o grafo. Revisão independente pendente. Ver `implementation/SANDBOX-WRITER-RETIREMENT-20261104.md`.

No grafo com broker/workers Docker sintéticos reais, a receita v1 sintética agora registra a identidade da tarefa para permitir a dispensa autorizada. O ensaio passou sem criar grant, job ou aprovação de QA para a tarefa dispensada; receitas históricas sem identidade continuam conservadoras. A falha anterior e os limites estão em `implementation/CONTINUACAO-SYNTHETIC-WAIVER-20261104.md`.

Backup/restauração foram repetidos com dados sintéticos em checkout e banco próprios, incluindo rejeição de corrupção, pausa e concessão incerta, relocação de uma worktree e boot do runtime da cópia com admissão fechada. Zero runs nativos na segunda cópia. Ver `implementation/CONTINUACAO-RESTORE-20261104.md`.

A bancada isolada reproduziu worker Docker vivo, takeover e parada, preservando a posse bloqueada, além de dois hosts SSH sintéticos com perda de ACK, reinício e exportação Git. Os limites e logs estão em `implementation/CONTINUACAO-SANDBOX-SSH-20261104.md`. Não houve aceite dos cenários integrais.

O painel permite ao titular assinar autorização de dispensa para tarefa, política e template ativos, e informa que o alcance é o projeto. O grafo com PostgreSQL e worktrees Git reais, modelos e QA sintéticos passou nas variantes válida, ausente, desabilitada, divergente e ambígua. A variante válida também foi observada após reinício com contexto pausado. A aprovação de QA não foi fabricada e a revisão continua obrigatória. Não é prova de interrupção durante o efeito.

A cópia managed não é mais entregue a outra intenção, inclusive após neutralização legada; a operação de neutralização recusa até existir prova física. Essa contenção, por si só, não revoga acesso nem encerra processo; o broker sintético acrescentado depois observa e retira o contêiner nos casos concluídos descritos acima. Os registros abaixo sobre reassumir a mesma cópia são históricos e foram superados. RF-54, T34, RF-57 e T38 continuam parciais e sem aceite. Revisão independente continua pendente. Detalhes e limites em `implementation/CONTINUACAO-QA-WORKTREE-20261104.md`.

## Incremento: template ativo, ingresso da dispensa e lease de worktree — 04/11/2026

A dispensa só classifica a primeira tentativa como risco baixo quando a única autorização casa com o template de catálogo ativo do contexto. Sem esse template, o QA executa. O owner registra a autorização pelo comando assinado `qa.waiver.authorize` em `POST /api/v1/ac/control`, com a mesma prova de operador dos outros comandos. O painel ainda não tem botão para esse comando.

A materialização managed passa a exigir uma posse em `ac_worktree_writers`. Outra intenção recebe `WORKTREE_WRITER_BUSY`. A mesma intenção repete a posse. Um diretório já existente na primeira posse é `WORKTREE_RESIDUE` e não é apagado. Depois de `neutralized`, outra intenção pode reassumir a mesma cópia. O grafo ainda não chama a neutralização, e a função não mata processo nem altera permissão. RF-54, T34, RF-57 e T38 continuam `not_accepted`.

A revisão independente dos commits anteriores está registrada em `CONTINUACAO-CURSOR.md`. Nesta rodada o typecheck saiu 0. As provas puras e PostgreSQL descartável saíram 0. O container descartável foi removido depois. O banco de laboratório já em execução não foi alterado.

## Incremento: o nó de QA respeita a dispensa explícita — 04/11/2026

Quando existe uma única autorização do owner para a tarefa, na revisão de política do contrato, a primeira tentativa registra o artefato como `low` e o nó de QA grava `not_required` sem recibo de verificação, sem concessão e sem lançar o verificador. Duas autorizações para a mesma tarefa não dispensam. Correção (`correctionRevision` maior que zero) continua em risco alto e executa QA. Evidência `failed`, `canceled`, `missing_result` ou `stale` bloqueia e não grava a dispensa. Outro artefato não reutiliza a linha anterior; a mesma autorização pode gerar uma linha nova só para ele. A retomada de um estágio concluído com esse recibo não chama `quality.record`.

Neste processo o typecheck saiu 0. As provas puras e as duas suítes PostgreSQL, num banco descartável criado para esta rodada, saíram 0: 10 testes, 0 falhas, 0 skips. O banco de laboratório já em execução e os demais contêineres não foram alterados. O container descartável foi removido depois da prova. Não houve sessão completa de `EngineeringStages` com worktree e verificador. RF-57 e T38 continuam `not_accepted`.

## Incremento: vínculo explícito da dispensa de QA — 04/11/2026

A dispensa deixa de ser só principal e motivo. O owner autoriza antes, numa linha imutável, a revisão da política, o template, a regra `explicit-low` e a tarefa. A dispensa do artefato copia esses digests e o digest do próprio artefato. `assertReady` só aceita essa combinação como condição de QA sem recibo. Evidência `failed`, `canceled`, `missing_result` ou `stale` continua `VERIFICATION_NOT_PASSED`. Outro commit não herda a linha. Risco que não seja `low` não vira dispensa. O grafo nativo segue registrando artefato `high` e executando QA. Revisão independente continua obrigatória.

Neste processo `npm run typecheck` saiu 0. O avaliador puro saiu 0, com 5 testes e 0 skips. A suíte PostgreSQL de integridade do gate saiu 0 sem executar casos, porque `AC_TEST_DATABASE_URL` está ausente. Essa ausência não prova autorização, migração nem `assertReady`. RF-57 e T38 continuam `not_accepted`. Detalhes em `implementation/QA-WAIVER-BINDING-20261104.md` e `CONTINUACAO-CURSOR.md`.



Atualizado em 03/11/2026. Branch local `task/2f963b0e4808/consolidate-integration-lines`, a partir de `orchestration/ebfe5a1009ce`, com o conteúdo de `orchestration/5e95aef73635` e `orchestration/dcbac224b999`. Os merges `--no-ff` das duas linhas foram gravados no host pelo gerente, porque o Git do sandbox do trabalhador é somente leitura; o conflito em `agent-control-fetch.test.ts` manteve os testes dos dois lados.

**Produto em implementação. Nenhum gate completo ou homologação de produção está declarado.** A arquitetura autorizada permanece Cezar + Happier + PostgreSQL. As instalações operacionais não foram migradas ou reconfiguradas. Não há inferência com contas reais nesta bancada.

## Incremento: painel para materializar exportação SSH existente — 04/11/2026

O painel passa a listar, só para administrador global e owner, até 100 exportações `git-export` concluídas e ainda sem repositório. A projeção traz os IDs necessários, o rótulo admitido, commit, tree, SHA-256 e `exported`/`not_reviewed`. Não traz bundle, caminho, hostname, prova ou chave. A lista não substitui a autorização: o serviço revalida assinatura, membership e recibo no efeito. `POST /api/v1/ac/project-admin/remote-source` aceita somente `project.materializeRemoteSource`, com leitura limitada a 96 KiB, prazo e cancelamento. A rota antiga permanece em 16 KiB. O bundle decodificado continua em 64 KiB. O operador escolhe o snapshot e o arquivo local, compara o SHA-256 antes de assinar e reenvia a mesma intenção com outra entrega. O storage não guarda os bytes. Não há descarte depois de envio incerto. Se a resposta se perde e o snapshot sai da lista, a mesma intenção é retomada pelos IDs, commit, tree e digest gravados, com o mesmo arquivo e outra entrega. A materialização não volta a ser candidata e a pendência só sai depois da resposta confirmada. Não cria projeto, contexto, host, autorização nem exportação. Devolução, SSH operacional e aceite integral ficam de fora. Neste processo `npm run typecheck` saiu 0 e a UI saiu 0 com 13 testes, incluindo a retomada depois que o snapshot sai da lista. O typecheck web saiu 0. Neste processo o comando focado saiu 1 porque `AC_TEST_DATABASE_URL` está ausente: 4 testes HTTP sem PostgreSQL passaram e 9 lançaram `ISOLATED_DATABASE_REQUIRED` antes do produto. Isso não é defeito. O comando focado posterior do controlador saiu 0. Uma execução anterior saiu 1 com `ISOLATED_DATABASE_REQUIRED` antes do produto, porque `AC_TEST_DATABASE_URL` estava ausente; isso não é defeito e não foi repetido. O typecheck web saiu 0 depois do build oficial de `@happier-dev/protocol`, sem stub, com evidência em `/home/app/srv_projetos/orchestration/reports/l19-infra-20261104/`. RF-51, RF-36 e T25 continuam `not_accepted`. Revisão independente continua obrigatória. Detalhes em `implementation/REMOTE-SOURCE-PANEL-20261104.md`.

## Incremento: plano de retenção no CLI — 04/11/2026

`retention-plan <descritor-absoluto>` imprime o plano de `planRetention` e retorna antes de carregar instalação, PostgreSQL, cofre ou CLI de provedor. O descritor privado traz `schemaVersion` 1, `inventory` e `policy` no formato já aceito pela função. Esse inventário e essa observação de disco são fornecidos; o comando não os descobre nem os atesta. A leitura abre cada componente a partir do descritor do diretório anterior, sem seguir symlink. Um ancestral trocado por symlink antes da leitura, ainda com o mesmo inode da folha, é recusado e não é lido. A troca é feita por um loader só do processo de teste. O produto não lê `RETENTION_PLAN_OPEN_BARRIER` e não grava outro arquivo. O arquivo é regular, do UID atual, com um link, modo privado e no máximo 2 MiB. Modo `0644` com `nlink` 1 é recusado à parte do hardlink. Não há `--apply`, checkpoint, timer de retenção ou varredura de artefato. Exit 0 quando a admissão do inventário passa; exit 3 quando o código é `STORAGE_LOW_SPACE`; exit 1 com stderr fechado e stdout vazio para uso ou descritor inválido. O CLI não libera espaço e não homologa disco cheio, backup, retenção operacional, RNF-11 nem a fase I7. Nesta correção `npm run typecheck` saiu 0. Os testes focados de CLI, política e admissão de disco saíram 0: 18 testes, 0 falhas, 0 skips. Nenhum dos 111 requisitos foi aceito. Detalhes em `implementation/RETENTION-CLI-20261104.md`.

## Incremento: origem SSH no repositório do projeto — 04/11/2026

`project.materializeRemoteSource` materializa um snapshot `git-export` já autorizado como work tree sob a raiz confiável de menor id, em `remote-sources/<projectId>`, e grava `ac_project_repository_identity` na mesma transação da proveniência 059. O pedido não escolhe caminho nem comando. Antes de apagar, escrever, clonar ou renomear, os componentes de locks, staging e `remote-sources` são classificados com `lstat`. Symlink ou descendente gravável por grupo/outros é `PROJECT_PATH_FORBIDDEN`, sem reparar modo e sem seguir o link. A exclusão é um advisory lock de sessão; só o token do `owner` apaga o lock. Pid morto da mesma intenção adota a árvore igual. Dono ausente ou truncado é refeito sob o lock. Outra intenção recebe `REMOTE_SOURCE_MATERIALIZATION_BUSY`. O snapshot continua `not_reviewed` e não vira artefato. O painel mostra host, commit, tree e estado, sem chave nem prova. Devolução ao destino e o limite de 64 KiB ficam de fora. Nesta revisão, `npm run typecheck` saiu 0, a UI do painel saiu 0 com 6 testes e o typecheck web saiu 0. Os testes PostgreSQL não passaram da ausência de `AC_TEST_DATABASE_URL`: saíram 1 com `ISOLATED_DATABASE_REQUIRED` antes do produto. Isso não é defeito do produto. A prova anterior 6/6 e a fixture SSH não cobrem esta contenção. RF-51 e T25 continuam `not_accepted`. Detalhes em `implementation/REMOTE-SOURCE-PROJECT-20261104.md`.

## Incremento: versões de workflow fixadas — 04/11/2026

O runtime passa a registrar, em código, a versão atual `v1` e a retida `v0` de cada workflow built-in, com digest canônico e política explícita `pinned`. Não há auto-upgrade. A migração aditiva 058 grava, por execução, a build do runtime e a versão derivada do plano congelado. Recuperação e retomada continuam no snapshot quando o digest está retido e é idêntico. Versão aposentada ou divergente fica estacionada com `WORKFLOW_VERSION_RETIRED`, sem despacho. Execução nova usa só a versão atual. Plano antigo sem pino não é aposentado: a versão é derivada do digest. O diagnóstico e a view de recursos existentes mostram, só leitura e sem corpo de workflow, as versões em uso e os bloqueios. Continue-As-New não se aplica a este motor Cezar; a equivalência é a fixação do snapshot. Retenção física de workers antigos não foi homologada.

Nesta retomada `npm run typecheck` saiu 0. `tests/workflow-versioning.test.ts` saiu 0: 1 teste de catálogo passou e 1 foi ignorado com `AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado`. `tests/completed-node-recovery.test.ts` saiu 1: os nove casos lançaram `ISOLATED_DATABASE_REQUIRED` antes de migrar ou retomar. O arquivo de teste não foi alterado. Não há `psql` nem escuta PostgreSQL neste processo. Esse resultado não prova recuperação com definição alterada, concessão, auditoria idempotente nem a retomada anterior. Nenhum dos 111 requisitos foi aceito. RF-52 e T32 continuam `not_accepted`. Detalhes em `implementation/WORKFLOW-VERSIONING-20261104.md` e `architecture/ADR-012-VERSOES-DE-WORKFLOW.md`.

## Incremento: catálogo de templates por projeto — 04/11/2026

O projeto passa a ter um catálogo de revisões imutáveis de configuração de fluxo. A identidade é um UUID, o nome é humano e limitado, e cada revisão guarda o snapshot `Template` já existente, o digest canônico e o autor. Publicar e aplicar usam o mesmo `Control.execute` assinado do painel, com `project-template.publish` e `project-template.apply`. O projeto sai do contexto autorizado e do `projectScope`; só o titular publica ou aplica. Aplicar copia a revisão exata para o contexto de destino do mesmo projeto. Essa cópia não muda quando o catálogo ganha outra revisão. A operação não cria conta, perfil, plano ou execução.

A trava da identidade usa `hashtextextended` com um array JSON `["project-template", projeto, template]`. A chave anterior continha NUL e o PostgreSQL recusaria o parâmetro `text` antes de gravar. O teste de aplicação agora repete a mesma intenção com a mesma entrega e com entrega nova, também depois de outra publicação do catálogo, e exige o resultado original e uma só revisão local. Essa contraprova está no arquivo, mas não rodou aqui.

A view de recursos lista no máximo 100 linhas, ordenadas por nome, identidade e revisão, e omite snapshot ou digest inconsistente. A resposta antiga, sem `projectTemplates`, continua válida no painel. O formulário fica no `AgentControlSection`, mostra revisão e conflito, e usa a mutação assinada já existente. Nesta correção `npm run typecheck` saiu 0 com o `dist` do Cezar já presente. `tests/project-templates.test.ts` saiu 0: 1 teste de schema passou, incluindo a chave sem NUL, e a suíte PostgreSQL foi ignorada com `AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado`. `psql` e `/tmp/ac-l10-k3eehnkq` também estão ausentes. Esse skip não prova migração, concorrência, identidade estrangeira, rollback nem replay. A UI isolada saiu 0, 5 testes. Uma execução paralela anterior estourou um teste em 5000 ms e matou o typecheck web; isolados, os dois saíram 0. Nenhum dos 111 requisitos foi aceito. Detalhes em `implementation/PROJECT-TEMPLATES-20261104.md`.

## Incremento: falha terminal nativa no diagnóstico — 04/11/2026

O diagnóstico já autorizado do contexto passa a mostrar job nativo armazenado como `failed`. O motivo fica num conjunto fechado do controlador ou do finalizador, ou `unknown` quando o código falta, é desconhecido ou diverge. A resposta antiga continua válida. A leitura não verifica assinatura, não copia texto bruto e não muda execução, seleção ou recuperação. Isso torna a falha observável. Não prova nem encerra a causa desconhecida do native-multitask do L11. Neste runner `npm run typecheck` saiu 0. `tests/native-failure-diagnostics.test.ts` passou 4 e ignorou a suíte PostgreSQL: `AC_TEST_DATABASE_URL` ausente. Esse skip é ausência de prova. O teste de UI saiu 0, 1 teste. O typecheck web saiu 0 depois de `dist` local ignorado do Cezar e de `@happier-dev/protocol`; sem esses artefatos os mesmos comandos falhavam por módulo ausente, fora do diff. Nenhum dos 111 requisitos foi aceito. Detalhes em `implementation/NATIVE-FAILURE-DIAGNOSTICS-20261104.md`.

## Incremento: motivos de espera no cockpit — 04/11/2026

`Control.view` passa a incluir `exclusions` na espera já devolvida por `/resources` quando o jsonb armazenado passa na validação fechada de `capacityWaitExclusions`. A leitura continua na mesma transação de `authorize` e de `projectScope`. Lista nula, histórica ou inválida omite o campo. O cockpit existente mostra a lista ordenada em português. O rótulo do perfil só aparece se ele já está na view autorizada; perfil ausente usa identificação curta, sem consulta fora do projeto. `CAPACITY_BUSY` e `CAPACITY_QUEUED` continuam distintos de inelegibilidade, e a composição local não ganha motivos de perfil. Não houve mudança de grant, cota, seleção, catálogo, migração nem autoridade.

Neste runner `npm run typecheck` saiu 0. `tests/capacity-wait-resources.test.ts` saiu 0 e a suíte foi ignorada: `AC_TEST_DATABASE_URL` ausente. Esse skip é ausência de evidência, não prova PG. Os testes de UI `agent-control-capacity-waits.test.tsx` e `agent-control-section-diagnostics.test.tsx` saíram 0, 3 testes, quando rodaram sozinhos. Uma execução paralela anterior estourou o tempo do teste de diagnóstico e o typecheck web foi morto com sinal; isso foi contenção do runner, não falha da página. O typecheck web seguinte saiu 0 depois de um `dist/index.d.ts` local e ignorado pelo Git em `@happier-dev/protocol`, porque o tsconfig do cockpit já segue o import de autenticação Happier e o build desse pacote não estava presente. Esse arquivo não faz parte do produto desta fatia. Nenhum dos 111 requisitos foi aceito. Detalhes em `implementation/CAPACITY-WAIT-COCKPIT-20261104.md`.

## Estado vigente: despacho nativo delimitado

A receita `engineering-native-v1` liga a mensagem cifrada autorizada ao grafo Cezar, com escopo/base congelados, finalização de artefato, QA físico, revisão independente e integração do commit exato. A prova integrada passou, incluindo ACK perdido, duplicação recusada e recuperação após troca de gerente. O despacho e a revisão também selecionam supervisor pela conta concedida; falha de preparação anterior ao lançamento libera a vaga exata. Programação e revisão na prova usam substitutos sintéticos; nenhuma conta real foi ativada. Ver `implementation/NATIVE-DISPATCH-20261103.md`.

O bootstrap nativo passou a ter configuração discriminada e opt-in. O padrão continua administrativo, sem execução e sem inferência. Configuração incompleta ou incompatível é recusada antes de efeitos. A conta configurada só passa se estiver autorizada no projeto e se `resource_identity` for `codex:` mais o digest declarado. O opt-in configurado não compõe supervisores nem ativa contas: SQL 042 e Capacity permanecem, e o estado publicado é bloqueio de ativação, não prontidão. O `serve` anexa esse bloqueio ao runtime do projeto e recusa `start("execution")`. A bancada só aceita adaptadores injetados, retém esses substitutos sem chamá-los e não chama modelo. Cada leitura exige registry injetado e revalida `Ledger.fence` mais `endpoint.lastError`; registry ausente, fechado, erro de autoridade conhecido ou takeover no ledger com o registry antigo aberto recusam antes do resolver, sem fabricar autoridade do contrato congelado. O shutdown segue após `close` ou consulta de liberação rejeitada, preserva o que ficou incerto e não trata uma falha como limpeza vazia concluída. A prova de bancada instancia o `CezarRuntime` real sem modelo. Ver `implementation/NATIVE-BOOTSTRAP-20261103.md`.

Correções nativas limitadas após reprovação autenticada de QA ou revisão estão implementadas para planos com várias tarefas. Cada tentativa nova tem intenção, execução, operação, sessão e avaliação próprias, até o `maxCorrections` do plano. Falha de infraestrutura não grava decisão nem lança a tentativa seguinte. O commit reprovado permanece no histórico e não é selecionado nem reutilizado. A receita v2/v3 sintética continua só como referência de contrato. `nativeExecutionRecipe` ainda recusa correção, para o plano nativo sem correção permanecer o contrato anterior. O reconhecimento da revisão nativa fica em `EngineeringStages`; `src/quality.ts` não mudou. A bancada com adaptadores injetados captura a ref protegida depois da integração aprovada de `gamma` e exige que o limite esgotado e a falha de infraestrutura deixem esse commit no lugar. O produto não foi alterado para desfazer essa integração. A administração relatou a prova isolada em contêiner descartável, com este worktree somente leitura, sem contas e sem socket Docker: `tests/native-corrections.test.ts` 2/2 e `tests/native-multitask.test.ts` 3/3, zero skips, com substitutos sintéticos, sem inferência e sem homologação. Os diretórios citados não estão montados neste runner e os logs não foram reabertos. Aqui `AC_TEST_DATABASE_URL` continua ausente, então o teste autenticado segue ignorado: `npm run typecheck` saiu 0, `native-corrections.test.ts` passou 1 e ignorou 1, `native-multitask.test.ts` passou 2 e ignorou 1. Nenhum dos 111 foi aceito. Detalhes em `implementation/NATIVE-CORRECTIONS-20261103.md`.

A linha ebfe, já neste branch, acrescenta avaliação pura de SLOs, `GET /api/v1/ac/observability/slo`, o painel administrativo, o plano puro de rotação da custódia local, o verificador puro de restore e o percurso móvel de propostas até 390 px. Nenhuma dessas provas usa conta real, inferência, deploy ou migração, e nenhuma aceita requisito. Ver `implementation/SLO-EVALUATION-20261103.md`, `implementation/SLO-API-20261103.md`, `implementation/SLO-UI-20261103.md`, `implementation/KEY-ROTATION-PLAN-20261103.md`, `implementation/RESTORE-VERIFIER-20261103.md` e `implementation/MOBILE-PLANS-20261103.md`.

Parsers puros de cota estão em `src/provider-collector-parsers.ts`. Codex, Claude e Grok projetam disponível, esgotado, recuperação ou desconhecido a partir de fixtures sintéticas. Antigravity permanece desconhecido: a origem não traz cota verificável. Não há spawn, rede, credencial, scheduler nem gravação de observação. Ver `implementation/PROVIDER-COLLECTOR-PARSERS-20261103.md`.

A retenção é um plano dry-run. `planRetention` classifica um inventário já fornecido. O CLI `retention-plan` só imprime esse plano e não apaga arquivo. Evidência de aceite, evidência genérica, item ativo ou incerto e backup sem restore comprovado não entram em `propose`. Disco cheio recusa admissão nova com `STORAGE_LOW_SPACE` em `src/disk-admission.ts` e não apaga arquivo. Ver `implementation/RETENTION-DISK-FULL-20261103.md` e `implementation/RETENTION-CLI-20261104.md`.

A carta de aprovação de integração em largura até 390 px mostra digest, política, destino e diff, com alvo de 44 px. Intenção e entrega saem do POST observado; registro corrompido não chama a aprovação. A prova é jsdom, sem aparelho. Ver `implementation/MOBILE-APPROVAL-20261103.md`.

Permanecem pendentes contas e cotas reais, coleta operacional, retenção aplicada, homologação de disco cheio, aparelho móvel e revisão independente. As seções abaixo são registros históricos de incrementos; suas pendências devem ser lidas com este estado mais recente. O projeto continua incompleto. Nenhum dos 111 requisitos está aceito.

## Estado vigente: QA funcional real

QA por comando autorizado foi implementado e ligado ao Cezar/Quality. Dois casos funcionais rodaram em contêineres reais sem rede, credenciais ou montagem gravável do código: um passou, outro falhou; uma mensagem de aprovação impressa pelo teste não alterou a saída observada. A branch protegida permaneceu intacta. Ver `implementation/NATIVE-QA-20261103.md`.

O projeto segue incompleto: faltam despacho nativo, contexto autorizado, integração de bootstrap e homologação real/móvel, entre os demais aceites abertos. O QA é uma capacidade entregue, ainda não uma homologação geral dos testes de qualquer projeto. As seções seguintes preservam o histórico dos incrementos.

## Estado vigente: artefatos e revisão nativos

Finalização de código nativo, registro de artefato e revisão independente tipada foram ligados ao supervisor/Quality e ao ciclo de observação do Cezar. A prova com PostgreSQL, Git e helper reais passou com turnos/contêineres simulados. Sem QA, a integração continuou bloqueada. Detalhes: `implementation/NATIVE-ARTIFACT-REVIEW-20261103.md`.

Ainda faltam a receita de despacho nativo, o contexto autorizado das tarefas, QA confiável de código real e a homologação do fluxo inteiro com provedores e interface móvel. O bootstrap continua administrativo. As seções seguintes preservam o histórico; esta seção resume o incremento mais recente. O projeto não está completo.

## Incremento: worker e canal de ferramentas — 03/11/2026

Existe uma entrada assinada para trabalhadores Codex e um encaminhador local para um peer privado de ferramentas. Assinatura, identidade sintética e tráfego de bytes foram verificados em bancada; o teste de rede não demonstra isolamento entre dois contêineres. A imagem não foi ativada. Ainda faltam o broker físico, rede exclusiva verificada, worktrees, conferência de artefato e integração ao fluxo. Detalhes em `implementation/NATIVE-EXECUTION-WORKER-20261103.md`.

## Incremento: adapter Codex de execução — 03/11/2026

O adapter para programação e funções de avaliação fixa o modelo, esforço e ambiente remoto, exige escopo para programação e commit/schema para avaliação, e rejeita saídas de turnos falhos ou incompletos. O runner recusa pedidos interativos dos trabalhadores gerenciados. As provas usam processos simulados; o supervisor físico de programação/revisão, a integração de artefatos e a homologação continuam pendentes. A instalação segue administrativa. Detalhes em `implementation/CODEX-EXECUTION-ADAPTER-20261103.md`.

## Incremento: cancelamento do planejamento nativo — 03/11/2026

O runtime pode receber supervisores nativos para parar e observar o job original cancelado, inclusive após troca de gerente. A chave e a identidade do contêiner são conferidas; sem prova terminal a concessão não é liberada. A prova atual usa PostgreSQL descartável e Docker simulado. A instalação administrativa não ativa o recurso nem executa modelos reais. Detalhes em `implementation/NATIVE-PLANNING-CANCELLATION-20261103.md`.

## Incremento: conversa e proposta semântica — 03/11/2026

O endpoint Happier agora pode encaminhar mensagens a um gerador semântico explicitamente injetado, preservando a intenção e o conteúdo cifrado na mesma transação. No laboratório, confirmação perdida, pausa, colisão e cancelamento de proposta pronta não duplicaram execução nem marcaram a proposta como programação; cancelamento de resultado incerto permanece pendente. O template visual fica desabilitado quando o gerente semântico ou a execução não estão habilitados. Detalhes em `implementation/SEMANTIC-CONVERSATION-20261103.md`.

A instalação configurável permanece administrativa: a opção não foi ativada, nenhum modelo real foi chamado e propostas ainda não iniciam programação automaticamente. Integração operacional, classificação e resposta a perguntas, revisão/programação reais, contexto completo e fallback continuam pendentes.

## Incremento vigente: planejamento e execução nativa delimitada

Planejamento semântico com journal PG, seleção de adaptador/perfil por concessão, recibos assinados e publicação transacional foi implementado e provado com executor sintético e HTTP. Pausa e confirmação perdida preservam a mesma chamada. Paralelismo explícito de 1–10 conserva quatro para planos antigos; conta/limites reais continuam sob Capacity. O runner Cezar envia esforço e fixa ambiente remoto de ferramentas; uma prova offline com CLI oficial e HOME vazio confirmou conexão e recusa de chave inválida.

Worker e supervisor nativos de **planejamento**, receitas de imagem e proxy restrito foram implementados, mas não ativados. A prova negativa recusa conta dormente antes de Docker/credenciais. O sandbox nativo com bubblewrap falhou neste host; a topologia de ferramentas separadas ainda precisa de homologação. Não há programação/revisão real, gerente semântico contínuo integrado à instalação, ativação de conta ou inferência nesta entrega. Gateway permanece administrativo. Detalhes, comandos e limitações: `implementation/SEMANTIC-NATIVE-EXECUTION-20261102.md`.

## Implementado e observado

| Área | Implementação e evidência delimitada |
|---|---|
| Autoridade | PostgreSQL, ACL, contextos independentes, gerente por instância/época/lease, planos congelados, intenções/entregas/outbox, deduplicação e recusa de ingressos não admitidos. |
| Conversa | Happier real como histórico cifrado canônico, relay/RPC/pending queue, paginação e checkpoint; Cezar sem segundo composer. Notificações agrupadas cifradas e ACK estrito; ManagerRegistry por contexto com cópias privadas da chave e fencing. |
| Contas e capacidade | Contas **sintéticas**, catálogo, papéis e cadeias versionadas, concessões globais, filas, quotas com TTL, seleção regular e reserva da conta original. Contas/perfis podem ser desativados sem liberar efeitos incertos. |
| Engenharia | Receita de propostas congeladas com tasks/filhos em worktrees próprias, Cezar como dono do DAG e composição determinística seguida de novos QA/revisão e CAS. Implementações/verificadores Docker e compositor local supervisionado, todos sintéticos; preflight explícito. |
| Recuperação | SIGKILL após implementação física e QA físico; replay de QA/revisão/julgador/integração concluídos; observação de CAS aplicado sem repetir escrita. Preparações comprovadamente não lançadas podem ser adotadas; efeitos sem prova e outros intervalos permanecem abertos. |
| Operação | Pausa no limite de nós, drenagem de planos aceitos, espera por capacidade na mesma tentativa, cancelamento pedido/confirmado com bloqueio de novos efeitos e preservação de grants incertos. ADR-004/005. |
| SSH | Dois hosts descartáveis, fingerprints fixados, diário idempotente, confirmação perdida e recibo concluído após reinício. Operação em trânsito permanece conservadoramente incerta. |
| Administração | Registry PG multi-projeto e seleção nativa; login Happier V3 com cookie opaco e dispositivo por principal; propostas versionadas/preview nativo; Settings Cezar: seis papéis, cadeias ordenadas, limites globais/locais, catálogo, perfis, estados de conta, pausa/drenagem/cancelamento, templates, políticas de qualidade, aprovação assinada com diff do artefato e uso observado. Comandos assinados por dispositivo. Atualização periódica de estado não substitui CAS/assinatura. |
| Operação de disco | Guarda opt-in de admissão nos executores/broker e spool privado de descartáveis, com reservas PG e limpeza por digest. Não varre caches legados, worktrees ou evidências. |
| Telemetria | Agregados administrativos PG read-only e Prometheus com labels fechados; nenhuma transcrição/credencial/ID de conta exposta. |
| Backup | Backup cifrado, extração e importação em banco novo com admissão fechada, relocação de Git/worktrees e leitura de runtime sem despacho. Origem conferida intacta. Não é prova de restore operacional completo. |

## O que ainda impede considerar o projeto pronto

1. Bootstrap administrativo configurável e pareamento Happier V3 estão implementados sem fixture, com ativação de dispositivo separada. Custódia local opt-in AES-GCM e fonte explícita de chave foram acrescentadas; rotação e custódia completas, autostart, gerente semântico, execução de produto e homologação móvel real permanecem pendentes. A entrada administrativa não lança workers.
2. Coletores de cota sintéticos versionados alimentam Capacity, com vínculo assinado, TTL e quarentena de probe incerto. Permanecem adaptadores e elegibilidade de provedores/CLIs reais e gestão de credenciais. Uso real depende das autorizações específicas previstas na diretriz; não habilitar contas silenciosamente.
3. Propostas, contratos e execução dinâmica sintética com filhos isolados/composição/avaliação/CAS estão integrados e possuem prova física. Correções limitadas após reprovação autenticada foram implementadas em receita v2, com novas identidades e avaliações; especialista independente pré-implementação foi acrescentado em v3. Ambos exigem bootstrap sintético explícito e não ativam execução administrativa. Ainda faltam autoria semântica por modelo e políticas completas. Não confundir o fixture determinístico com programação por CLI real.
4. Recuperação managed foi exercitada em dois pontos de SIGKILL no grafo sintético de duas tasks e composição: resultado físico da task antes de aplicar Git/PG e CAS da composição antes do ACK PG. O sucessor preservou identidades e não repetiu o CAS; pausa e época antiga foram verificadas. Isso não cobre todos os intervalos de fork/join, correção ou escritores externos. Compositor órfão sem recibo terminal reconciliável permanece incerto e não autoriza liberar capacidade ou repetir efeito. A prova de writer vivo do broker é baseline, não uma prova de worktree managed. Ver `CORE-INDEPENDENT-REVIEW-20261102.md` e `managed-recovery-kill-fourth-20261102.log`.
5. Homologar cancelamento pelo SSH real, queda durante efeito e morte do supervisor. Novas operações já têm vínculo de plano obrigatório/imutável; somente histórico sem vínculo conserva a restrição de contexto. O pedido de parada tem prova local de supervisor, não homologação de rede.
6. As provas Chromium cobrem seleção nativa, propostas e EventSource aberto, além de cadastro de terceiro projeto e prévia sanitizada em viewports 360/390. Aparelho físico, tela nativa de aprovação, todos os percursos e operação autônoma real ainda não homologados. Inspeções independentes identificaram e confirmaram correções de escopo, revogação e shutdown do stream.
7. Restore completo de conversa/UI, efeitos externos posteriores ao backup, ensaio em outro host, métricas/SLOs, retenção/disco cheio, piloto e migração autorizados.
8. Aceites restantes da matriz de **111 RF/RNF/T**, inclusive P1/P2 conforme prioridade e autorização. Não converter presença de código ou teste sintético em gate aprovado.

## Integração aguardando aprovação humana

A etapa agora aguarda a decisão sem falhar ou repetir implementação. O painel permite inspecionar o diff real e aprovar somente o digest/política/destino congelados; QA/revisão/CAS permanecem obrigatórios. Prévia truncada bloqueia a ação. ADR-006 registra o limite de diffs maiores e as provas sintéticas.

## Paralelismo do grafo

O runtime não usa mais silenciosamente o teto standalone de dois fluxos: o semaphore nativo acompanha o orçamento PG. Pausa, falta de capacidade e aprovação humana usam a espera nativa, liberando vagas de fluxo sem liberar grants físicos. A fila não mantém intenção cancelada como cabeça. ADR-007 e as provas focadas registram o alcance; não há benchmark de oito workers reais.

## SSH vinculado ao plano

Novos despachos exigem intenção do mesmo contexto, sem bloquear planos vizinhos por cancelamento. O pedido remoto de parada só vira confirmação após o supervisor observar saída física. O cockpit expõe estado e vínculos antigos. A fronteira está disponível para injeção explícita no runtime; nenhum host/credencial real foi habilitado. ADR-008 distingue a prova Python local e o contrato PG de uma homologação SSH completa.

## Recuperação ampliada

Resultados concluídos de QA, conselho, julgador e integração podem ser relidos pelo sucessor sem repetir seus executores. O recibo físico de QA também pode ser conciliado antes da gravação do controlador. CAS aplicado com confirmação PG perdida é observado sem nova escrita; destino que não prova a pós-condição permanece incerto. Pausas continuam preservadas. ADR-009 registra as provas, os negativos e os limites.

A retomada cobre também cursor anterior ao registro de QA, QA registrado aguardando cota e integração registrada antes de admitir CAS. Exige prova de não início, preserva IDs e audita a tentativa/época nova, sem liberar writers incertos. ADR-010.

## Evidências recentes

- `docs/validation/evidence/execution-controls-regression-final-20261102.log`: 14 testes aprovados, sem skips; PG/Git/Cezar/processos sintéticos. A primeira rodada falhou por contaminação entre fixtures; a suíte global agora cria banco descartável próprio, sem modificar contas alheias.
- `docs/validation/evidence/plan-cancel-reconciliation-20261102.log`: recibo de parada forjado recusado, capacidade incerta preservada; confirmação do contrato usa stub de broker.
- `docs/validation/evidence/native-pause-capacity-20261102.log`: pausa antes do QA, cota sintética esgotada, espera e conclusão do mesmo run sem repetir implementação.
- Evidências e limites anteriores: `docs/validation/FINDINGS.md`, `docs/validation/TRACEABILITY.csv`, ADRs e manifesto em `docs/validation/evidence/`.

## Continuidade

Ler AGENTS, Diretriz Mestre, este arquivo e FINDINGS; conferir `git status`. Trabalhar somente neste repositório e compose `deploy/compose.lab.yml`. Não ligar filas/Paseos, usar contas reais ou migrar projetos. A instrução vigente do proprietário é trabalhar somente com o agente principal; equipes anteriores permanecem inativas, conforme AGENTS.md. A configuração histórica em TEAM-EXECUTION não substitui essa instrução. Priorizar implementação e verificações pertinentes, concentrando validação ampla em fronteiras de integração. Os testes que dependem de perfis Docker/SSH/Happier exigem seus serviços de bancada; não interpretar skip como aprovação.

O histórico cronológico foi preservado em `docs/implementation/CONTINUATION-20261102.md`. Afirmações antigas de pendências ou percentuais nesse histórico retratam a etapa em que foram registradas; este arquivo é o resumo vigente. Não há percentual de conclusão calculado e validado para o produto inteiro.

## Incremento paralelo de produto — 02/11/2026

- ADR-011: login reutiliza autenticação/criptografia Happier; chave de conteúdo não é entregue ao backend. Ativação administrativa continua independente.
- Entrada `npm run gateway -- initialize|operator-bootstrap|serve /config-privada.json`: bootstrap persistente, sem fixture de conta; execução não é ativada. Procedimento em `docs/implementation/BOOTSTRAP-OPERACAO.md`.
- Planejamento, provedores, retenção e telemetria: relatórios `docs/implementation/*PARALLEL-20261102.md` e documentação de operações descrevem provas e limites. Propostas válidas não são permissão de executar fluxos dinâmicos.
- Revisão independente encontrou bloqueios de primeira inicialização, transporte inseguro de token e tratamento de falha de entropia. Correções incorporadas, negativos preservados; não é homologação geral de segurança.

As correções de integração incluem middleware escopado (preservando login público), verificação explícita de E2EE, replay de cota expirado como unknown e espera por disco no próprio grafo. `browser-login-bootstrap-proof.json` registra o primeiro contexto e a deduplicação; `native-disk-wait-first-20261102.log` registra pausa/recurso/retomada na mesma execução. Empacotamento determinístico de commit e check no CI foram acrescentados; não houve publicação.

O layout compilado agora mantém `dist/upstream` físico e contratos emitidos separados da fonte. Build e importação da API compilada passaram após limpar somente quatro JS comprovadamente gerados; `docs/implementation/BUILD-LAYOUT-20261102.md`. A expansão de disco solicitada pelo proprietário também foi concluída online: raiz com cerca de 294 GiB totais e 117 GiB livres; isso não altera gates de produto.

## Equipe ampliada — checkpoint de integração

- CORE: `CORE-TEAM-20261102.md` e `CORE-INDEPENDENT-REVIEW-20261102.md`. Prova física final managed 2/2; tarefa falha impede composição/CAS. A recuperação sintética também passou nos dois pontos de SIGKILL delimitados acima. Recibos físicos e leitura complementar preservados. Não houve benchmark de overlap nem homologação geral de recuperação.
- Produto: `PRODUCT-TEAM-20261102.md`. ManagerRegistry, notificações e registry/gateway multi-projeto integrados, proprietários secundários sem administração global. O cadastro assinado posterior usa raízes privadas configuradas, conforme `PROJECT-ADMIN-20261102.md`; quatro runtimes abertos no máximo, evitando esgotar o pool PG.
- Stream: `src/workspace-stream.ts` reutiliza frames/RunStore nativos, filtra runs admitidos por PG/projeto/ACL, revalida autenticação por lote e fecha no shutdown. Não chama stream global nativo nem probes. Prova1/1 inclui revogação e listeners encerrados.
- Build root e Cezar integral/typecheck/web/check:pack passaram em `expanded-team-build-first-20261102.log`; warning de chunk grande permanece declarado. Nova prova HTTP de escopo e tipos finais registrados separadamente.
- Mobile: `product-mobile-native-stream-final-20261102.log` + JSON/provas360/390 confirmam troca de projetos/caches, conexão real de eventos e recusa honesta de execução sem gerente (zero intenções). Não usa CLI real nem telefone físico.
- O pacote de fontes agora omite quatro configurações públicas `.env` de desenvolvimento upstream, registrando as omissões; `.env` próprio e segredos continuam recusados.

A recuperação managed tem as provas delimitadas acima; estados sem prova física continuam bloqueados. Nenhuma conta/assinatura real, migração ou publicação foi ativada. Não há percentual formal de conclusão do produto inteiro.

## Continuação CORE e produto — 02/11/2026

- Recuperação: `managed-recovery-kill-fourth-20261102.log` passou 2/2 sem skips, com duas tasks, composição, QA/review e CAS. `managed-recovery-negative-final-20261102.log` cobre fork parcial órfão e pausa com PG real e RunStore simulado; `managed-recovery-adoption-check-20261102.log` registra separadamente a adoção de `compose-0`. O primeiro negativo e as tentativas de migração divergente permanecem preservados. `CORE-C-live-writer-first-20261102.log` cobre parada de writer físico baseline após troca de época, com recibo terminal, não worktree managed.
- Composição continua sintética e reserva capacidade local de programador, sem conta, perfil ou quota de modelo; permanece sujeita a limites global/contexto, fencing e fila. Crash após conclusão da composição antes de `child done`, compositor órfão, writer managed ativo e ref divergente por escritor externo não têm prova física específica. A ausência de recibo não libera grant por timeout e não autoriza outro writer.
- Cadastro de projeto usa administrador global, assinatura de dispositivo e raiz privada configurada; associação e replay são transacionais. `PROJECT-ADMIN-20261102.md` registra provas PG, HTTP e UI e os limites de caminhos confiáveis e corrida de filesystem. Não cadastra projetos reais automaticamente.
- Importação e manifesto oferecem apenas prévias sanitizadas, sem staging, importação, backup ou restauração. `IMPORT-PREVIEW-20261102.md` descreve limites, provas e negativos; autenticidade e integridade dos arquivos não são comprovadas pela prévia.
- Diagnóstico de contexto read-only em `GET /api/v1/ac/contexts/:id/diagnostics` usa ACL e projeto do runtime, relata fatos com evidências e apresenta `unknown` quando não há causa comprovada; não executa recuperação. `diagnostics-focused-first-20261102.log` passou 1/1 em PG descartável para escopo, redação e condições exercitadas. Aprovações e divergência de recibos não foram exercitadas nesse teste.
- Exportação Git por SSH produz snapshot marcado `not_reviewed`. Uma autorização de leitura separada, assinada pelo owner, vincula contexto, projeto, intenção, host, commit e tree e é exigida na exportação e no replay; ela não aprova merge nem altera o payload da intenção original. `remote-source-signed-first-20261102.log` prova o contrato em PG sintético; a prova SSH anterior não foi repetida após essa alteração. Fluxo de produto, limites agregados de recursos e recuperação de lock continuam abertos.
- `ManagerRegistry.restart` exige credenciais fornecidas novamente e revalida antes de encerrar/iniciar; não faz retry automático nem guarda credencial para reativação. `tests/managers.test.ts` contém contraprovas de chave, época e estado incerto; a disponibilidade por uma entrada administrativa com provedor de chave autorizado e prova operacional permanece pendente.
- `gateway inspect /config-privada.json` consulta prontidão local em modo somente leitura, sem inicializar instalação ou revelar configuração. `installation-readiness-focused-20261102.log` passou 2/2, incluindo PG descartável, TCP local e CLI. Isso não é homologação de disponibilidade operacional ou integração com provedores reais.
- O transporte de status do gerente diferencia indisponibilidade de conexão de perda de autoridade; `diagnostics-manager-transport-20261102.log` passou 1/1. Planos com `maxCorrections > 0` continuam visualizáveis, mas o preflight de execução os recusa explicitamente antes de criar receita/filhos; não há executor de correção. Ver `MANAGED-EXECUTION-LIMITS.md`.
- A terceira prova móvel sintética identificou dois títulos de diagnóstico; o negativo `product-diagnostics-duplicate-red-20261102.log` reproduziu chaves React duplicadas. Após correção das chaves e do `aria-label`, `product-admin-mobile-final-20261102.log` passou em Chromium 360/390 com um título, cadastro de terceiro projeto, prévia sanitizada e zero intenções de execução, operações, outbox e grants; a intenção administrativa de cadastro era esperada. A evidência e os limites estão em `PRODUCT-MOBILE-FINAL-20261102.md`. A responsável também relata teste focado 1/1 em execução direta sem log individual. Não houve telefone físico, UI nativa de aprovação Happier, inferência, conta real ou migração operacional; não é aceite geral.

## Capacidade local, fontes remotas e custódia — incremento atual

- A migração 040 separa grant `local_compositor` de `model`. `local-compositor-capacity-second-20261102.log` passou 1/1 em PG descartável: quota de modelo esgotada, fencing, limites, identidade e fila por capacidade local foram exercitados; sem worker físico ou inferência. A primeira rodada focada também foi preservada.
- A migração 041 registra autorização assinada de leitura de fonte Git e a valida antes da exportação e do replay. `remote-source-signed-first-20261102.log` passou 1/1 em PG; snapshot `not_reviewed` não é aprovação de integração e a prova SSH anterior não foi repetida com o novo contrato. A interface de fontes remotas está implementada, sem nova prova em navegador nesta rodada.
- Vault local opt-in usa AES-GCM e fonte explícita de chave no registry; `context-vault-focused-20261102.log` passou 2/2 para PG e timeout/limpeza de chave em memória. Comandos CLI de custódia foram adicionados, mas ainda não receberam teste integrado PG+CLI nesta rodada. Autostart e rotação/custódia operacional completa continuam pendentes.
- A interface de uso distingue compositor local de uso de modelo; o compositor não recebe tokens nem custo de inferência. O build conjunto desta rodada ainda estava em andamento no momento deste registro; não houve suíte ampla ou novo navegador, contas reais, autostart, migração de produção ou publicação.

A inspeção visual da primeira rodada final encontrou um toast `CANONICAL_HAPPIER_REQUIRED`, apesar dos asserts administrativos aprovados. A auditoria identificou uma gravação automática de novidades no estado nativo do workspace. Esse efeito e a telemetria nativa foram desativados somente no cliente managed, sem liberar endpoints recusados. `product-admin-mobile-native-effects-final-20261102.log` passou novamente com um diagnóstico, cadastro assinado, prévia e viewports 360/390, agora exigindo ausência dessas mutações e do toast. A captura final também foi inspecionada. Isso não afirma ausência de todos os GET recusados ou homologação de todos os percursos.

## Incremento de capacidade, fontes e custódia

O incremento de capacidade local, autorização de fonte e custódia está compilado: `development-integration-final-20261102.log` passou build próprio, tipos web e build gerenciado. O compositor mantém o mecanismo nativo de espera sem exigir cota de modelo; concessões incertas continuam ocupando capacidade. O painel permite autorizar a leitura de uma fonte remota sem iniciar o trabalho ou aprovar a integração. A custódia é opt-in, com comandos locais separados para inicializar o cofre, autorizar uma versão e importar a chave; não modifica o modo administrativo nem ativa gerentes. Não houve repetição das suítes amplas ou do navegador nesta rodada. Ver `LOCAL-CAPACITY-SOURCE-VAULT-20261102.md` e `CONTEXT-VAULT-CLI-20261102.md`.

## Mudança da equipe solicitada pelo proprietário

Configuração vigente: principal como único gerente/revisor, seis Terra Médio. Dois Sol extras e dois trabalhadores anteriores foram retirados da execução; o trabalho foi preservado e redistribuído diretamente. Não altera a quantidade de trabalhadores ou revisores configurada dentro do Agent Control. A revisão das entregas e a integração permanecem com o principal.

## Implementação continuada — correções, especialista e administração

Incremento de 02/11/2026, ainda não homologado para produção:

- Migrações 042–047: contas reais dormentes, decisões de correção, avaliação declarativa de elegibilidade, orientação pré-implementação, HOME por conta e operações administrativas registradas. Sem login, inferência ou ativação de conta real.
- A receita v2 cria até cinco novas tentativas após reprovação autenticada de QA/revisão. Falha de infraestrutura não é reprovação. `managed-corrections-final-20261102.log`: 2/2, sem skips, com executores sintéticos físicos, nova avaliação e CAS do artefato selecionado.
- A receita v3 admite consulta a especialista independente antes do escritor, incluindo novas tentativas. `managed-specialist-first-20261102.log`: 1/1, sem skips; parecer reprovado impediu escritor. Recuperação de v3 está sendo ampliada conservadoramente, sem afirmar cobertura de todos os intervalos.
- Backup cifrado do vault com chave externa distinta e restauração somente em destino novo/inativo. `context-vault-backup-focused-20261102.log`: 1/1; não representa restore operacional completo de aplicação ou credenciais reais.
- Elegibilidade registra declaração de owner, versão do adaptador, autenticação, fonte e validade. Não consulta termos nem comprova permissão do provedor. HOME reservado e vinculado a inode/UID não autentica CLI.
- Administração do gerente usa operações previamente registradas, política assinada, capability privada, journal anterior ao efeito, capacidade exclusiva e recibo Ed25519. Transporte Happier opt-in e painel de política integrados; bootstrap padrão não registra helpers nem habilita root. A chave de sessão autoriza RPC, sem provar qual modelo/dispositivo originou cada chamada.
- `administrative-operations-final-20261102.log`: 1/1 do serviço PG após remoção do emissor público de capabilities. Não é prova de helper privilegiado real nem do transporte Happier novo.
- Recursos Compose extras pertencentes às provas de correção/especialista foram encerrados; evidências e spools preservados. Instalações operacionais e baseline não foram limpas ou reiniciadas.

A implementação administrativa continua distinta da ativação operacional. Os 111 aceites não são promovidos automaticamente por estas entregas. Dispensa de QA managed permanece indisponível enquanto não houver classificação de risco autorizada e congelada pelo owner; propostas de agentes não podem se declarar de baixo risco.

### Exportação de metadados

Serviço read-only em snapshot PG repeatable-read e endpoint autenticado de owner foram ligados ao botão de download em Settings. Exporta versões e digests de planos/políticas, identidades Git e estados de evidências/integração, sem transcrições, paths, detalhes de audit ou credenciais. Limites: 100 registros por categoria e 256 KiB; o JSON identifica truncamento, `restorable:false` e `conversationIncluded:false`. Não é backup nem exportação completa de conversas. Teste focado foi preparado, não executado; a validação funcional fica pendente. A primeira checagem de tipos detectou uma conversão de arrays vazios, corrigida sem alterar contrato.

Build integrado de administração e recuperação: `administrative-recovery-integration-build-20261102.log` passou backend, tipos web e bundle managed. Bundle ainda gera aviso de tamanho; essa compilação não comprova comportamento de RPC/recuperação novos.

## Continuação com agente único

A partir da última instrução do proprietário em 02/11/2026, somente o agente principal desenvolve e revisa; os seis trabalhadores anteriores não devem ser reativados. Preservam-se os limites do produto, que são independentes da equipe de desenvolvimento.

Comandos locais explícitos `import-stage`, `import-deliver` e `import-archive` foram ligados ao gateway e ao core existente. Descriptors, bundle, token e chaves ficam em arquivos privados fora dos repositórios. Stage/deliver verificam a identidade da conta e as chaves/ciphertexts das sessões; novos contextos ficam pausados. O modo serve não dispara importações. Não foi executada migração real. Ver `IMPORT-CLI-20261102.md`.

O transporte agora recusa redirects, limita cada chamada de rede e rejeita ACK para localId divergente. Um teste focado com fetch simulado e a checagem de tipos estão registrados em `single-agent-import-diagnostics-20261102.log`; não equivalem a prova ponta a ponta do CLI ou migração operacional.

Diagnósticos foram ampliados com ausência de gerente quando existem intenções pendentes, admissão global fechada, orientação do especialista reprovada/incerta e operações administrativas incertas. Mantêm escopo/ACL, snapshot read-only, limites e indicação de responsável e próxima condição; nenhum diagnóstico inicia recuperação. Consultas novas ainda não possuem prova PG específica.

Pendências principais permanecem: integração operacional e homologação dos provedores reais, gerente semântico, fronteiras restantes de recuperação e validação integrada final. Não há conclusão integral ou percentual validado declarado nesta rodada.


### Exportação cifrada canônica pelo CLI

`export-context CONFIG DESCRIPTOR` acrescentado ao gateway local. Combina metadados limitados com ciphertexts do histórico Happier, sem decriptação/token/chave no pacote, e cria arquivo privado novo. ACL/owner revalidados por página; limites de tamanho/quantidade e cursor inválido abortam. Não há snapshot atômico entre PG e Happier ou restore automático. Código passou na checagem de tipos; exportação real e teste ponta a ponta não executados. Detalhes em `IMPORT-CLI-20261102.md`.

## Bootstrap configurável do transporte do gerente

`managerTransport` opcional liga registries por projeto ao vault e à sessão Happier explicitamente configurada. Verifica identidade do token, owner/contexto, chave e época; falha parcial e shutdown encerram transportes antes do runtime. A autoridade vigente passa às APIs de planejamento. Endpoint autenticado read-only e indicador em Settings mostram a conexão e distinguem execução/gerente semântico desabilitados.

O modo permanece administrativo e `transportOnly:true`: não consome pendências, não aceita novos pedidos de execução, não recupera/despacha planos e não ativa conta/modelo. Não foi criada ou alterada configuração operacional. Isto resolve uma ligação de bootstrap, não a implementação do gerente semântico e dos adaptadores reais, que continuam pendentes.

RPC, histórico e heartbeat passaram a revalidar ACL/projeto/vínculo/época; perda de autorização encerra transporte e limpa referências ao histórico recuperado. Build integrado passou e um teste local com ledger simulado cobriu recusa de acesso, projeto, época e sessão. Não houve conta real, conexão ponta a ponta ou repetição das suítes gerais. Ver `CONFIGURED-MANAGER-TRANSPORT-20261102.md`.

### Verificação de isolamento do worker nativo

Foi acrescentada uma primitiva que confere a identidade esperada dos dois contêineres, rede interna exclusiva, separação de montagens e leitura apenas para avaliadores. Ela ainda não está ligada a um supervisor físico; o teste usa observações sintéticas e não autoriza iniciar execução real. Detalhes e limites em `implementation/NATIVE-EXECUTION-WORKER-20261103.md`.

A inspeção somente leitura do par de contêineres foi ligada à primitiva de isolamento. Ela compara respostas do Docker com a configuração confiável, mas ainda não está integrada a um supervisor que crie e inicie os jobs. A prova atual utiliza respostas simuladas; não houve uso de contas ou daemon operacional.

## Supervisor nativo e ligação ao ciclo Cezar

O supervisor físico nativo foi implementado com journal PG, snapshots privados, par de contêineres, liberação por lançamento assinado após inspeção, observação conservadora, recibos e cancelamento no ciclo existente do Cezar. Três provas focadas passaram com PG/Cezar e Docker simulado. Uma prova separada conectou CLI oficial e ferramentas em dois contêineres reais, usando o encaminhador, sem conta ou inferência.

Ainda não foi ligado o despacho de uma receita nativa, a finalização do código gerado nem a avaliação real ao integrador; o caminho completo de `start` físico ainda precisa de prova. O bootstrap administrativo continua sem ativação. Ver `implementation/NATIVE-EXECUTION-SUPERVISOR-20261103.md`. O projeto permanece incompleto; esta entrega não autoriza dizer 100%.
