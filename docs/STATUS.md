# Agent Control — estado atual de implementação

Atualizado em 03/11/2026. Branch local `task/2f963b0e4808/consolidate-integration-lines`, a partir de `orchestration/ebfe5a1009ce`, com o conteúdo de `orchestration/5e95aef73635` e `orchestration/dcbac224b999`. Os merges `--no-ff` das duas linhas foram gravados no host pelo gerente, porque o Git do sandbox do trabalhador é somente leitura; o conflito em `agent-control-fetch.test.ts` manteve os testes dos dois lados.

**Produto em implementação. Nenhum gate completo ou homologação de produção está declarado.** A arquitetura autorizada permanece Cezar + Happier + PostgreSQL. As instalações operacionais não foram migradas ou reconfiguradas. Não há inferência com contas reais nesta bancada.

## Incremento: motivos de espera no cockpit — 04/11/2026

`Control.view` passa a incluir `exclusions` na espera já devolvida por `/resources` quando o jsonb armazenado passa na validação fechada de `capacityWaitExclusions`. A leitura continua na mesma transação de `authorize` e de `projectScope`. Lista nula, histórica ou inválida omite o campo. O cockpit existente mostra a lista ordenada em português. O rótulo do perfil só aparece se ele já está na view autorizada; perfil ausente usa identificação curta, sem consulta fora do projeto. `CAPACITY_BUSY` e `CAPACITY_QUEUED` continuam distintos de inelegibilidade, e a composição local não ganha motivos de perfil. Não houve mudança de grant, cota, seleção, catálogo, migração nem autoridade.

Neste runner `npm run typecheck` saiu 0. `tests/capacity-wait-resources.test.ts` saiu 0 e a suíte foi ignorada: `AC_TEST_DATABASE_URL` ausente. Esse skip é ausência de evidência, não prova PG. Os testes de UI `agent-control-capacity-waits.test.tsx` e `agent-control-section-diagnostics.test.tsx` saíram 0, 3 testes, quando rodaram sozinhos. Uma execução paralela anterior estourou o tempo do teste de diagnóstico e o typecheck web foi morto com sinal; isso foi contenção do runner, não falha da página. O typecheck web seguinte saiu 0 depois de um `dist/index.d.ts` local e ignorado pelo Git em `@happier-dev/protocol`, porque o tsconfig do cockpit já segue o import de autenticação Happier e o build desse pacote não estava presente. Esse arquivo não faz parte do produto desta fatia. Nenhum dos 111 requisitos foi aceito. Detalhes em `implementation/CAPACITY-WAIT-COCKPIT-20261104.md`.

## Estado vigente: despacho nativo delimitado

A receita `engineering-native-v1` liga a mensagem cifrada autorizada ao grafo Cezar, com escopo/base congelados, finalização de artefato, QA físico, revisão independente e integração do commit exato. A prova integrada passou, incluindo ACK perdido, duplicação recusada e recuperação após troca de gerente. O despacho e a revisão também selecionam supervisor pela conta concedida; falha de preparação anterior ao lançamento libera a vaga exata. Programação e revisão na prova usam substitutos sintéticos; nenhuma conta real foi ativada. Ver `implementation/NATIVE-DISPATCH-20261103.md`.

O bootstrap nativo passou a ter configuração discriminada e opt-in. O padrão continua administrativo, sem execução e sem inferência. Configuração incompleta ou incompatível é recusada antes de efeitos. A conta configurada só passa se estiver autorizada no projeto e se `resource_identity` for `codex:` mais o digest declarado. O opt-in configurado não compõe supervisores nem ativa contas: SQL 042 e Capacity permanecem, e o estado publicado é bloqueio de ativação, não prontidão. O `serve` anexa esse bloqueio ao runtime do projeto e recusa `start("execution")`. A bancada só aceita adaptadores injetados, retém esses substitutos sem chamá-los e não chama modelo. Cada leitura exige registry injetado e revalida `Ledger.fence` mais `endpoint.lastError`; registry ausente, fechado, erro de autoridade conhecido ou takeover no ledger com o registry antigo aberto recusam antes do resolver, sem fabricar autoridade do contrato congelado. O shutdown segue após `close` ou consulta de liberação rejeitada, preserva o que ficou incerto e não trata uma falha como limpeza vazia concluída. A prova de bancada instancia o `CezarRuntime` real sem modelo. Ver `implementation/NATIVE-BOOTSTRAP-20261103.md`.

Correções nativas limitadas após reprovação autenticada de QA ou revisão estão implementadas para planos com várias tarefas. Cada tentativa nova tem intenção, execução, operação, sessão e avaliação próprias, até o `maxCorrections` do plano. Falha de infraestrutura não grava decisão nem lança a tentativa seguinte. O commit reprovado permanece no histórico e não é selecionado nem reutilizado. A receita v2/v3 sintética continua só como referência de contrato. `nativeExecutionRecipe` ainda recusa correção, para o plano nativo sem correção permanecer o contrato anterior. O reconhecimento da revisão nativa fica em `EngineeringStages`; `src/quality.ts` não mudou. A bancada com adaptadores injetados captura a ref protegida depois da integração aprovada de `gamma` e exige que o limite esgotado e a falha de infraestrutura deixem esse commit no lugar. O produto não foi alterado para desfazer essa integração. A administração relatou a prova isolada em contêiner descartável, com este worktree somente leitura, sem contas e sem socket Docker: `tests/native-corrections.test.ts` 2/2 e `tests/native-multitask.test.ts` 3/3, zero skips, com substitutos sintéticos, sem inferência e sem homologação. Os diretórios citados não estão montados neste runner e os logs não foram reabertos. Aqui `AC_TEST_DATABASE_URL` continua ausente, então o teste autenticado segue ignorado: `npm run typecheck` saiu 0, `native-corrections.test.ts` passou 1 e ignorou 1, `native-multitask.test.ts` passou 2 e ignorou 1. Nenhum dos 111 foi aceito. Detalhes em `implementation/NATIVE-CORRECTIONS-20261103.md`.

A linha ebfe, já neste branch, acrescenta avaliação pura de SLOs, `GET /api/v1/ac/observability/slo`, o painel administrativo, o plano puro de rotação da custódia local, o verificador puro de restore e o percurso móvel de propostas até 390 px. Nenhuma dessas provas usa conta real, inferência, deploy ou migração, e nenhuma aceita requisito. Ver `implementation/SLO-EVALUATION-20261103.md`, `implementation/SLO-API-20261103.md`, `implementation/SLO-UI-20261103.md`, `implementation/KEY-ROTATION-PLAN-20261103.md`, `implementation/RESTORE-VERIFIER-20261103.md` e `implementation/MOBILE-PLANS-20261103.md`.

Parsers puros de cota estão em `src/provider-collector-parsers.ts`. Codex, Claude e Grok projetam disponível, esgotado, recuperação ou desconhecido a partir de fixtures sintéticas. Antigravity permanece desconhecido: a origem não traz cota verificável. Não há spawn, rede, credencial, scheduler nem gravação de observação. Ver `implementation/PROVIDER-COLLECTOR-PARSERS-20261103.md`.

A retenção é um plano dry-run em memória (`src/retention-plan.ts`). Evidência de aceite, evidência genérica, item ativo ou incerto e backup sem restore comprovado não entram em `propose`. Disco cheio recusa admissão nova com `STORAGE_LOW_SPACE` em `src/disk-admission.ts` e não apaga arquivo. Ver `implementation/RETENTION-DISK-FULL-20261103.md`.

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
