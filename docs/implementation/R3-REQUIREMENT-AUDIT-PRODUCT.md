# Auditoria independente dos requisitos — produto R3

Base `ae2e141b60e6ea90125dd43babb97e9a0abc0f16`. São 48 linhas originais; as outras 63 pertencem ao revisor runtime. Este inventário é separado da matriz e registra diferenças de implementação, prova e pré-requisito externo. Não promove evidência histórica a reexecução nem requer conta real para critérios puramente locais. RF-43, RNF-14 e T17 são candidatos específicos a aceite após prova final do critério exato, não aceites automáticos.

## RF-01

Critério literal: Cadastrar projeto, repositório, branch, ambientes e diretórios autorizados pelo painel

Implementado: Signed project registry/admin API derives paths under authorized roots; browser proof registers local synthetic repositories.

Falta: Complete registration of environments and remote destinations with same authorization and filesystem race proof.

Externo: Operational host/project authorization.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-02

Critério literal: Administrar vários projetos e destinos em uma única central

Implementado: One registry and scoped runtime selection support several synthetic projects.

Falta: Multi-destination operational lifecycle and isolation beyond four configured active runtimes.

Externo: Authorized destination installation.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-03

Critério literal: Criar contextos com histórico estável, preservado ao trocar conta, modelo e CLI

Implementado: Happier is canonical encrypted conversation; stable context/session mapping and 151-message export proof exist.

Falta: Continuous real manager/account/model/CLI handoff with identical history and vault custody across restart.

Externo: Eligible provider accounts and official authentication.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-05

Critério literal: Representar duas contas do mesmo provedor sem usuários/empresas artificiais

Implementado: Global accounts and resource identities represent distinct same-provider accounts without artificial organizations.

Falta: Physical two-account identity/credential/usage isolation integrated with live adapters.

Externo: Two explicitly authorized eligible subscriptions.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-06

Critério literal: Autenticar por mecanismos oficiais de assinatura, sem API paga silenciosa

Implementado: Private HOME provisioning and disabled nonsynthetic accounts enforce fail-closed activation.

Falta: Official subscription login lifecycle and execution proof; inactive guard is refusal, not authentication implementation acceptance.

Externo: Account owner authorization and supported official mode.

Classificação: `blocked_external_plus_implementation_gap`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-07

Critério literal: Configurar papel, perfil, esforço, conta, prioridade e substituições visualmente

Implementado: Role/profile/capacity/reserve editors share validated policy commands.

Falta: All role, priority and fallback configuration through signed browser-to-PG flow and error paths.

Externo: Physical Android for T16 only; RF07 itself can be proven in browser.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-08

Critério literal: Validar catálogo e combinações antes de publicar uma política; rejeitar modelo/esforço inexistente

Implementado: Synthetic catalog and policy validation reject invalid role/model/effort; runner pins requested effort.

Falta: Versioned official discovery/catalog synchronization and integrated invalid model admission proof.

Externo: Official eligible CLI/catalog contract.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-09

Critério literal: Exibir versão aplicada e explicar por que um perfil foi escolhido ou recusado

Implementado: Stored capacity selection includes policy/config revisions, effective total position, chain and reason; scoped UI labels exclusions.

Falta: Combined signed browser/PG proof chosen and refused profiles after policy change.

Externo: None for synthetic contract; real protocol approval separate.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-10

Critério literal: Distinguir cota esgotada, limite temporário, autenticação inválida, falha de rede e estado desconhecido

Implementado: Collectors/parsers separate exhausted, rate_limited, auth_required, unreachable and unknown conservatively.

Falta: Production registered official source and durable escaped-process quarantine; timeout never proves logout or exhaustion.

Externo: Authorized official CLI protocol and account.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-25

Critério literal: Integrar somente artefato aprovado, com proteção contra tentativa antiga e mudança da base

Implementado: Exact artifact quality gate and protected Git CAS bind approval/base; physical synthetic graph and revocation races were exercised.

Falta: Remaining crash/CAS/cancellation intervals and stale external writer interleavings across production path.

Externo: Eligible real agents only for semantic quality, not CAS proof.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-30

Critério literal: Exibir uso, cota e renovação por conta quando observáveis; indicar desconhecido quando não observáveis

Implementado: Fresh normalized observed percentage/reset are distinct from reported attempt usage; missing balance remains unknown.

Falta: Account-facing registered observable source and full stale/recovery display journey.

Externo: Official observable quota interface.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-31

Critério literal: Produzir auditoria de decisões, trocas, tentativas, revisão, integração e intervenção humana

Implementado: Durable audit records cover manager, intent, policy, quality, integration and human actions; scoped diagnostics exist.

Falta: Completeness/retention audit across all ingress and export decisions under restart.

Externo: Operational retention policy.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-32

Critério literal: Permitir os percursos essenciais de configuração e operação pelo celular

Implementado: Synthetic Chromium360/390 proofs cover selected administration/proposal/approval screens.

Falta: Full account-team-fallback-plan-pause-resume-delivery mobile journey with suspension/reconnect.

Externo: Authorized physical Android device for T16.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-33

Critério literal: Importar histórico, planos e evidências dos Paseos sem duplicar trabalho concluído

Implementado: Import stage/deliver/archive and paused contexts enforce manifest/context identities; existing synthetic import proves dedupe slices.

Falta: End-to-end historical plans/evidence import plus completed-work dedupe after failed/repeated restore.

Externo: Authorized legacy snapshot; no operational migration permitted.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-34

Critério literal: Exportar configuração e relatórios sem credenciais; oferecer backup e restauração

Implementado: Encrypted disposable backup/restore, hashes, relocated worktree and admission-closed startup were exercised.

Falta: Complete configuration/report export and coherent multi-store recoverability/custody proof; verifier itself does no restore.

Externo: Operational backup destination and approved recovery exercise.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-35

Critério literal: Notificar conclusão agrupada e bloqueio relevante, com deduplicação e histórico

Implementado: Durable cursors dedupe observations; completion batching and immutable ciphertext ACK retry retain history.

Falta: Real Happier publication/reconnect proof and exclusion of irrelevant child notifications end to end.

Externo: Push destination authorization if physical push required.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-36

Critério literal: Alterar configuração pelo chat usando a mesma API validada do painel, sem edição livre de arquivos internos

Implementado: Signed Control/project-admin APIs are shared validated primitives.

Falta: Chat tool route for policy/config changes with same validation and prohibition of internal file editing; current materialize panel is insufficient.

Externo: Eligible chat manager for live usage only.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-37

Critério literal: Oferecer editor livre de grafos e editor móvel equivalente por etapas

Implementado: Graph and mobile step editors reuse validation/save; real Cezar YAML persists after two restarts at360/390/1280.

Falta: Touch interaction completeness and all graph operations across both editor modes.

Externo: Optional physical device confirmation; P1 remains committed.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-39

Critério literal: Operar diretamente em worktree remota via adaptador homologado, com consistência de artefatos

Implementado: SSH operation/export primitives are implemented.

Falta: Homologated direct remote worktree adapter with writable artifact consistency; export/materialize is a different mode.

Externo: Authorized SSH adapter/host homologation.

Classificação: `missing_named_capability_or_scenario`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-40

Critério literal: Coletar e exportar uso, perfil, tentativas, tempo e retrabalho corretamente; oferecer comparação simples com limitações explícitas. Análises estatísticas/painéis avançados ficam em P1

Implementado: Cumulative per-attempt usage deduplicates and keeps overlapping counters separate.

Falta: Export of usage/profile/attempt/time/rework plus simple labeled comparison; advanced analytics remain P1.

Externo: Live usage source for operational telemetry.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-41

Critério literal: Separar aprovação da entrega, integração, publicação e deploy em permissões diferentes

Implementado: Human integration approval is artifact/target bound.

Falta: Distinct delivery, publication and deploy capabilities with independent permission denial counterproofs.

Externo: Deploy target authorization for actual deployment; policy denials testable locally.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-42

Critério literal: Validar edição concorrente de políticas e disponibilizar reversão para uma versão anterior

Implementado: Revision CAS rejects stale publish; immutable policy versions and assignPolicy support historical assignment.

Falta: Signed concurrent browser-to-PG edit conflict and visible rollback journey with immutable old attempt snapshot.

Externo: None for synthetic proof.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-43

Critério literal: Cadastrar templates reutilizáveis por projeto sem duplicar os dados de contas globais

Implementado: Project catalog immutable revisions reference frozen workflow settings without global account duplication; signed publish/apply validates digest and project scope.

Falta: Full browser publish/apply proof and revalidation of semantic template quality dependencies.

Externo: None for synthetic catalog contract.

Classificação: `criterion_largely_implemented_pending_final_version_proof`. Recomendação: `candidate_for_acceptance_after_final_integrated_proof_of_exact_criterion`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-46

Critério literal: Compartilhar autoridade de admissão e renovação de credenciais entre antigo/novo durante migração e reversão, ou impedir sobreposição de contas

Implementado: No shared old/new authority implementation exists at R3 base.

Falta: Admission plus credential-renewal shared authority or proven nonoverlap, including rollback and live unknown grants.

Externo: Legacy integration authorization; synthetic adapters can prove technical slice first.

Classificação: `missing_named_capability_or_scenario`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-50

Critério literal: Exibir grafo de execução somente de leitura com estado, dependências, agentes, falhas e correções no desktop e celular

Implementado: Read-only native graph/scoped stream projects dependencies, state and diagnostics; selected mobile screens proved.

Falta: Live correction/reconnect consistency, responsible actors and projection delay across graph/cards.

Externo: Physical phone for full T16; browser suspension proof possible locally.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-51

Critério literal: Materializar com segurança um projeto Git inicialmente acessível somente por SSH, sem exigir GitHub ou login de IA no destino

Implementado: Signed owner SSH export/materialize binds host, operation, commit/tree/hash and immutable provenance; snapshot remains not_reviewed.

Falta: Complete safe initial-source path for larger bundles and controlled delivery integration; materialization alone is not approval.

Externo: Operational SSH host authorization.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-53

Critério literal: Deduplicar comandos móveis e reconexões pela identidade da intenção, independentemente da entrega HTTP/WebSocket

Implementado: Intent identity and digest dedupe are distinct from delivery IDs in ledger/Control.

Falta: All start/pause/resume/policy ingress replay and timeout/reconnect through mobile and WS/MCP.

Externo: Physical mobile confirmation for T27 final journey.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RF-55

Critério literal: Verificar para cada provedor, plano, titular, CLI/adaptador, autenticação e modo de uso a elegibilidade oficial; login ou resposta técnica não são prova suficiente.

Implementado: Versioned eligibility metadata expires and binds adapter/auth/mode; live activation remains blocked.

Falta: Independent official provider/plan/holder/mode eligibility verification; owner assertion is not official eligibility.

Externo: Official terms and authorized account-specific review.

Classificação: `blocked_external_plus_implementation_gap`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RNF-04

Critério literal: Fluxos essenciais utilizáveis em telas de 360 e 390 px de largura, além do desktop; sem dependência de hover

Implementado: 360/390/desktop Chromium geometry and selected44px targets plus native editor persistence are evidenced.

Falta: Every essential workflow usable without hover, full touch navigation/error/suspension checks.

Externo: Physical Android required by T16, not by literal viewport criterion alone.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RNF-05

Critério literal: Toda tarefa parada informa motivo, evidência, responsável pela recuperação e próxima condição de avanço

Implementado: Diagnostics emits explicit reason, evidence references, owner and nextCondition for pause/admission/manager/effect/quality findings.

Falta: Exhaustive coverage for every stopped task and PG behavioral proof of all added branches/truncation.

Externo: None for synthetic coverage.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RNF-08

Critério literal: Segredos não aparecem em histórico Temporal, conversa, log exportável, prompt ou artefato

Implementado: Vault encryption, redacted allowlist exports and restricted harness environment reduce secret propagation.

Falta: Canaries across conversation, workflow state, logs, prompts and artifacts over all adapters; arbitrary agent output is not universally scrubbed.

Externo: Operational custody review.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RNF-10

Critério literal: Backup com restauração demonstrada; meta inicial de desastre RPO até 24 h e RTO até 2 h, a confirmar no piloto

Implementado: Disposable encrypted backup restoration with pause/unknown effects retained is demonstrated.

Falta: Measured RPO<=24h/RTO<=2h pilot with complete stores and external reconciliation.

Externo: Authorized pilot disaster exercise and off-host custody.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RNF-12

Critério literal: Meta inicial: aceite de comando em até 2 s e atualização de evento em até 5 s no ambiente homologado; autenticação/provedor externos medidos separadamente

Implementado: No homologated response/event latency measurement implementation/evidence at base.

Falta: Measure command acknowledgement<=2s and event update<=5s; separate external authentication/provider latency.

Externo: Defined homologated environment and representative workload.

Classificação: `missing_named_capability_or_scenario`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RNF-14

Critério literal: Cota não observada nunca é apresentada como disponível ou percentual estimado sem identificação

Implementado: Usage returns subscriptionBalance unknown; parser rejects unproven/stale quota and UI uses explicit unknown.

Falta: Audit every display/admission projection, including fresh-to-stale transition, on integrated version.

Externo: No external account needed to prove unknown behavior.

Classificação: `criterion_largely_implemented_pending_final_version_proof`. Recomendação: `candidate_for_acceptance_after_final_integrated_proof_of_exact_criterion`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## RNF-15

Critério literal: Planos, políticas, histórico e evidências exportáveis; credenciais tratadas em procedimento separado

Implementado: Redacted bounded metadata export plus encrypted151-message Happier export exclude credentials and refuse overwrite.

Falta: Full plans/policies/history/evidence portability; capacity export only summarizes configured roles and lacks reconstructible full policy; common-store snapshot absent.

Externo: Separate credential-custody procedure.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T01

Critério literal: Identidade, credencial e uso separados; nenhuma troca silenciosa

Implementado: Synthetic accounts/HOME isolation primitives exist.

Falta: Exact two-Codex-account scenario with separate identity/credential/usage and no silent swap is unexecuted.

Externo: Two eligible authorized Codex subscriptions.

Classificação: `missing_named_capability_or_scenario`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T02

Critério literal: Ordem, elegibilidade, handoff e motivos corretos; nenhuma API paga

Implementado: Synthetic ordered chains, eligibility and fallback reasons are tested.

Falta: Exact Grok->Codex->Gemini->Sonnet Antigravity->reserve complete handoff unexecuted.

Externo: Eligible official subscriptions/adapters for every named provider.

Classificação: `blocked_external_plus_implementation_gap`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T13

Critério literal: Estados distintos, recuperação apropriada; nenhuma falsa marca de esgotamento

Implementado: Parser/source tests distinguish transport, authentication, invalid model and unknown classes; unknown never exhausted.

Falta: Whole adapter recovery test for auth expiry/network failure/invalid model before new admission.

Externo: Official protocol fixture validation; account only for live homologation.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T16

Critério literal: Conta, equipe, fallback, plano, pausa, retomada e entrega administráveis

Implementado: Chromium mobile widths prove selected administrative paths.

Falta: Actual Android full account/team/fallback/plan/pause/resume/delivery journey absent.

Externo: Authorized physical Android/device session.

Classificação: `missing_named_capability_or_scenario`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T17

Critério literal: Contadores sem dupla soma; saldo desconhecido permanece desconhecido

Implementado: Usage test repeats same event, rejects conflict/regression, advances cumulative cache/reasoning and preserves unknown balance.

Falta: Reexecute PG test on final integrated revision; source semantics must identify cumulative counters before operational use.

Externo: None for exact synthetic arithmetic criterion.

Classificação: `criterion_largely_implemented_pending_final_version_proof`. Recomendação: `candidate_for_acceptance_after_final_integrated_proof_of_exact_criterion`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T18

Critério literal: Histórico e política íntegros; tarefas integradas não duplicadas

Implementado: Disposable restore validates archive/dump hashes, pause/uncertain grant and one relocated managed runtime.

Falta: Canonical history/policy completeness and duplicate integrated-work proof through backup+restore+reimport as one scenario.

Externo: Authorized legacy snapshot only for operational migration.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T22

Critério literal: Rejeição antes do lançamento e motivo legível

Implementado: Policy validator and readable exclusion projections reject known invalid synthetic combinations.

Falta: Exact prohibited Astra/effort/removed-account cases before any launch via signed policy command and browser reason.

Externo: None for rejection proof; no actual provider call needed.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T25

Critério literal: Materialização versionada, teste do artefato e devolução controlada; nenhuma CLI/login de IA no destino

Implementado: Two-host signed SSH source export/materialization binds distinct commits/trees; no AI login on destination.

Falta: Test approved artifact then controlled return with exact base CAS, replay/lost ACK and distinct permission.

Externo: Authorized actual host only for operational homologation.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T27

Critério literal: Mesma intenção tem um único efeito; comandos diferentes continuam distintos

Implementado: Ledger/Control distinguish intent and delivery IDs; revision controls reject stale changes.

Falta: Mobile timeout/reconnect replay for all four start/pause/resume/policy commands and distinct intents.

Externo: Physical device final confirmation.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T28

Critério literal: Uma autoridade de reservas/refresh; soma global dentro do teto; sem conceder vaga por snapshot divergente

Implementado: No old/new shared admission+refresh protocol exists at base.

Falta: Pilot failure and rollback with shared authority/global tally; stale snapshot cannot grant; refresh fenced too.

Externo: Authorized legacy adapter; synthetic technical proof is possible.

Classificação: `missing_named_capability_or_scenario`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T31

Critério literal: Estados distintos; probe serializado e limitado; sem tempestade, falsa cota ou emergência indevida

Implementado: Provider collector serializes/throttles probes and uses conservative TTL; synthetic provider feeds real PG admission.

Falta: Combined unknown-capacity/recent-success/unknown-balance/concurrent-probe scenario including durable timeout quarantine.

Externo: Official quota protocol for live scenario only.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T35

Critério literal: Grafo de leitura e cartões mostram mesmo estado real, responsáveis e atraso de projeção, sem perder navegação

Implementado: Scoped native stream and proposal/cards were exercised in browser.

Falta: Suspend/reconnect while actual correction changes state; graph/cards same identity/state/owner/projection delay without losing navigation.

Externo: No external provider needed with synthetic runtime; physical phone remains final mobile gap.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.

## T39

Critério literal: Recusa prévia e legível, sem marcar cota falsamente nem habilitar API paga ou transporte alternativo

Implementado: Eligibility refusal/exclusion is distinct from exhausted quota; guards forbid real activation and alternate API transport.

Falta: Exact technically-functional but ineligible adapter denies before spawn through integrated signed entry and legible UI.

Externo: No real call needed to prove refusal; official eligibility assessment separate.

Classificação: `implemented_slice_missing_integration`. Recomendação: `do_not_accept_full_requirement`. Fonte/versão e evidências individuais estão no JSON; revisão estática, sem reexecução presumida.
