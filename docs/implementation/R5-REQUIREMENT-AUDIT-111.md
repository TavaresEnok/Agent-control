# R5 — checkpoint independente dos 111 critérios

A matriz oficial permanece inalterada. Esta consolidação reúne as recomendações de produto R4 (48) e o inventário histórico runtime R3/R4 (63); o último não é uma revisão R4 integral concluída. Pareceres R4 já aprovados continuam válidos apenas nas versões e escopos que descrevem. O JSON preserva critério, fontes, recomendações e próxima evidência; nenhuma prova histórica é apresentada como nova execução.

Prioridade: T21 correção QA física; T30 restauração de backup antigo com trabalhadores externos mais novos vivos; handoff Cezar e barreira de projeto; importação RF33 e exportação RF34; grafo assinado e jornadas móveis. RNF08 mantém a lacuna de composição de segredo apesar das 23 superfícies aprovadas. Nenhuma dessas lacunas locais é automaticamente uma dependência externa.

| Critério | Origem | Recomendação / estado | Próxima evidência |
| --- | --- | --- | --- |
| RF-01 | R4 produto | accept_for_scope | — |
| RF-02 | R4 produto | accept_for_scope | — |
| RF-03 | R4 produto | do_not_accept_full_requirement | Executar troca concreta de executor/CLI com identidade/contexto estáveis e comparar mensagens/seq/chave antes/depois, sem criar segundo histórico. |
| RF-04 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Registry lifecycle, stale manager route rejection and concurrent Ledger claim tests require independent rerun; provider exhaustion belongs to T19, not this exact-one-manager criterion. |
| RF-05 | R4 produto | accept_for_scope | — |
| RF-06 | R4 produto | do_not_accept_full_requirement | Implementar/verificar lifecycle oficial de autenticação para um provedor/plano/titular explicitamente autorizado. |
| RF-07 | R4 produto | do_not_accept_full_requirement | Percurso browser local cria/edita perfis, publica ordem regular/reserva e demonstra erro/conflito legível. Conta oficial não é necessária para esse critério visual. |
| RF-08 | R4 produto | accept_for_scope | — |
| RF-09 | R4 produto | accept_for_scope | — |
| RF-10 | R4 produto | accept_for_scope | — |
| RF-11 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Demonstrate healthy regular nonpreemption and emergency completion/return through real capacity workflow; deterministic trusted observations suffice for this control criterion. |
| RF-12 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Automatic recovery from official quota evidence through native bootstrap remains unverified; R3 fixture wiring pending |
| RF-13 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Cross-host same authority and resource identity contention not independently rerun in R3; coexistence authority separate |
| RF-14 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Capacity aging source preserves eligible age under retry/release; general historical backlog now bounded by3ca18eae. Actual multi-context physical stage graph fairness and resource release integration still pending. |
| RF-15 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Source compiler inspected; complete plan propose/publish native execution evidence not independently rerun |
| RF-16 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Pure parallel compiler test rerun, physical graph source/evidence pending R3 independent review |
| RF-17 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Physical specialist then writer graph with real capacity not independently rerun |
| RF-18 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Real-capacity graph independence and terminal outcome reconciliation pending R3 flow |
| RF-19 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Gate tamper and stale commit source tests exist but not independently rerun here |
| RF-20 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Native correction graph physical proof with real capacity not independently rerun |
| RF-21 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Technical recovery/probe retry global consumption budgets not proven across persistent outage |
| RF-22 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Historical reconciliation now durable bounded/fenced per3ca18eae; full composed workflow dispatch/wait/cancel/completion proof through actual capacity and public control pending R3 flow. |
| RF-23 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Bounded history and immutable remote orphan neutralization now independently proved for approved modules; full workflow entrypoint/fallback/recovery/intermediate crash matrix still requires composed integration verification. |
| RF-24 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Public signed control through graph with physical worker and reconnect evidence pending R3 |
| RF-25 | R4 produto | accept_for_scope | — |
| RF-26 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Independent rerun of authorized two-host SSH lab plus proof no IA credentials/login on targets pending; operational deployment is outside this criterion proof. |
| RF-27 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | — |
| RF-28 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Physical multiaccount cross-process/credential/remote isolation not independently rerun; remote source confinement pending |
| RF-29 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Full direct API/terminal hostile-worker matrix while preserving valid project admin missing |
| RF-30 | R4 produto | accept_for_scope | — |
| RF-31 | R4 produto | accept_for_scope | — |
| RF-32 | R4 produto | do_not_accept_full_requirement | Completar a jornada conta/equipe/fallback/plano/pausa/retomada/entrega em360/390 e reconexão/suspensão, usando entradas efetivamente entregues. |
| RF-33 | R4 produto | do_not_accept_full_requirement | Versionar o bundle e importar planos/evidências legadas identificadas com proveniência, pausa e dedupe de trabalho concluído; provar falha/reenvio/restore sem criar execução indevida. Não requer abrir Paseo operacional sem autorização. |
| RF-34 | R4 produto | do_not_accept_full_requirement | Inventariar/exportar parâmetros de projeto/ambiente/templates/perfis/adapters necessários sem credenciais e provar leitura/uso do artefato; preservar recuperação já demonstrada. |
| RF-35 | R4 produto | accept_for_scope | — |
| RF-36 | R4 produto | accept_for_scope | — |
| RF-37 | R4 produto | do_not_accept_full_requirement | Provar criação/ligação/remoção/edição das operações de grafo e equivalência nas etapas móveis, sem hover obrigatório. |
| RF-38 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Physical multi-reviewer/judge graph used synthetic capacity in R2; R3 actual capacity fixture pending |
| RF-39 | R4 produto | do_not_accept_full_requirement | Fechar página entregue→registro/factory real→workspace SSH→artefato exato, com revisão de consistência e versão homologada. |
| RF-40 | R4 produto | accept_for_scope | — |
| RF-41 | R4 produto | do_not_accept_full_requirement | Implementar/mostrar matriz de permissões delivery/integration/publication/deploy e recusas cruzadas antes dos efeitos. |
| RF-42 | R4 produto | accept_for_scope | — |
| RF-43 | R4 produto | accept_for_scope | — |
| RF-44 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Import/restore plus actual quota recovery preservation not jointly rerun |
| RF-45 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Cross-entry UI/chat/MCP/retry/fallback/recovery adversarial no-bypass sweep not complete |
| RF-46 | R4 produto | do_not_accept_full_requirement | Conectar o legado ao mesmo fence/reservas/refresh, ou demonstrar tecnicamente bloqueio de sobreposição no handoff/rollback autorizado. |
| RF-47 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Saturated programmer to evaluator progress with actual provider capacity graph pending R3 |
| RF-48 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Independent execution of complete forged/truncated/gate-removal and external-writer races pending |
| RF-49 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Full cross-account shell/symlink/process/API plus central admin attack coverage remains unverified |
| RF-50 | R4 produto | do_not_accept_full_requirement | Suspender/reconectar durante correção real e comparar grafo/cartões por mesma identidade/estado/owner/atraso sem perder navegação. |
| RF-51 | R4 produto | accept_for_scope | — |
| RF-52 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Real pending update/Continue-As-New migration with old-worker retention absent; pinning alone is not update strategy proof |
| RF-53 | R4 produto | do_not_accept_full_requirement | Mesmo teste representativo cruza start/pause/resume/policy após timeout/reconnect em seus ingressos entregues e distingue novas intenções. |
| RF-54 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Remote escaped descendant neutralization and successor shared-worktree physical matrix pending R3 |
| RF-55 | R4 produto | do_not_accept_full_requirement | Obter verificação documental independente por provedor/plano/titular/CLI/modo antes de ativação de conta real. |
| RF-56 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Two live contexts restart/disabled account state not independently rerun |
| RF-57 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Seven pure waiver cases rerun; integrated waiver revocation versus physical retirement race not rerun |
| RNF-01 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | All components intermediate launch/fallback/remote create windows not covered |
| RNF-02 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Host-shared resource epoch and operation claims now fence across state dirs; full ownership/CAS/state transition proof across all components still requires final integration verification. |
| RNF-03 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Pure file/security tests rerun; physical two CLIs account/process boundary not rerun |
| RNF-04 | R4 produto | do_not_accept_full_requirement | Fechar o conjunto de RF32 em todos viewports, sem hover e com erros/recuperação acessíveis. Android físico só para T16. |
| RNF-05 | R4 produto | accept_for_scope | — |
| RNF-06 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Protocol compatibility and all invasive upstream patches inventory not independently audited exhaustively |
| RNF-07 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Event/context efficiency quantities and all reuse paths not independently measured/audited |
| RNF-08 | R4 produto | do_not_accept_full_requirement | Conversa→planejamento→prompt→runner bem-sucedido→deltas SSE/logs→artefato/export, com canário e controles negativos; testar configuração hostil e backup composto. |
| RNF-09 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Verify persisted base/CLI/model/policy/image/code fields for every attempt kind, including retry/recovery; official account access is not prerequisite to schema/provenance counterproof. |
| RNF-10 | R4 produto | do_not_accept_full_requirement | Definir workload/ponto de corte de piloto e medir RPO≤24h/RTO≤2h em recuperação representativa, mantendo escritores quiescentes ou estratégia explicitamente suportada. |
| RNF-11 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Remote aggregate CPU/memory/PIDs and admission physically proved in5add3b71. Central native supervisors still use per-job fixed limits; admission-to-central aggregate CPU/RAM authority wiring must be verified/implemented alongside disk, slots and account capacity before full RNF11 acceptance. |
| RNF-12 | R4 produto | do_not_accept_full_requirement | Probe finita de aceite≤2s e evento≤5s sob workload/ambiente definidos, separando autenticação/provedor. |
| RNF-13 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Finite old/new/incompatible CLI protocol fixtures must prove default admission gated by contract confirmation; live account is not prerequisite. |
| RNF-14 | R4 produto | accept_for_scope | — |
| RNF-15 | R4 produto | accept_for_scope | — |
| T01 | R4 produto | do_not_accept_full_requirement | Executar apenas com duas assinaturas autorizadas e verificar fronteira física/identidade/uso sem troca silenciosa. |
| T02 | R4 produto | do_not_accept_full_requirement | Verificar protocolos/modos elegíveis e executar a cadeia nominal autorizada, sem API paga ou substituição silenciosa. |
| T03 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Exercise regular recovery while another regular healthy; assert no preemption or silent reassignment through real capacity paths; synthetic observations suffice. |
| T04 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Exercise emergency programming while regular recovers; finish healthy reserve and stop new reserve dispatch through real capacity paths; synthetic observations suffice. |
| T05 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Persist all-exhausted wait, restart then fresh trusted observation wakes same plan without chat command; Automatic recovery from official quota evidence through native bootstrap remains unverified; R3 fixture wiring pending |
| T06 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Pause before quota/restart and explicitly resume same plan with unchanged command identity; Import/restore plus actual quota recovery preservation not jointly rerun |
| T07 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Crash each intent/process/handle window and resend via UI/workflow/MCP; prove same process or uncertainty; Remote stable orphan group neutralization missing at base, R3 new primitive pending review |
| T08 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Crash launch/fallback/cancel windows; no legacy bypass, relaunch or stale integration; Remote stable orphan group neutralization missing at base, R3 new primitive pending review |
| T09 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Reject review, correct same task preserving findings, invalidate old evidence then evaluate new artifact; Native correction graph physical proof with real capacity not independently rerun |
| T10 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Two chats plus immediate external ref update must reject stale expected base atomically; Independent execution of complete forged/truncated/gate-removal and external-writer races pending |
| T11 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Concurrent chats and hosts contest global limit; no invalid grant and aged eligible queue progresses; Cross-host same authority and resource identity contention not independently rerun in R3; coexistence authority separate |
| T12 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Change policy grant/start/result; retain frozen snapshot or explicit revocation with coherent ticket state; Cross-host same authority and resource identity contention not independently rerun in R3; coexistence authority separate |
| T13 | R4 produto | do_not_accept_full_requirement | Ensaio local de adapter/executor registra as três falhas, recuperação apropriada e ausência de falsa cota esgotada. |
| T14 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Independent SSH disconnect/lost-ACK recovery test pending, including supervisor death and no blind uncertain-operation repeat; two authorized disposable hosts suffice. |
| T15 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Physical worker cross account/project/admin denied while legitimate work still completes; Pure file/security tests rerun; physical two CLIs account/process boundary not rerun |
| T16 | R4 produto | do_not_accept_full_requirement | Android autorizado: conta/equipe/fallback/plano/pausa/retomada/entrega e suspensão/reconexão. |
| T17 | R4 produto | accept_for_scope | — |
| T18 | R4 produto | accept_for_scope | — |
| T19 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Controlled exhaustion/recovery observation can prove handoff without official login; same-context canonical history, fenced singleton and safe return must be demonstrated together. |
| T20 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Inaccessible executor + expired lease cancellation keeps uncertainty/grant/old effects until proof; Remote stable orphan group neutralization missing at base, R3 new primitive pending review |
| T21 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Prove real QA defect returns through bounded correction to replacement artifact and fresh verification; permission correction 972373ad/1865dfec is scoped evidence only. |
| T22 | R4 produto | do_not_accept_full_requirement | Enviar essas três políticas pelo caller entregue e provar recusa legível antes de qualquer lançamento. |
| T23 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Malicious SSH file/output cannot reveal credential or modify central authority; valid project admin survives; Full direct API/terminal hostile-worker matrix while preserving valid project admin missing |
| T24 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Two actual concurrent CLIs denied shell/symlink/process credential access; distinct HOME insufficient; Pure file/security tests rerun; physical two CLIs account/process boundary not rerun |
| T25 | R4 produto | do_not_accept_full_requirement | Concluir prova página/factory/manager reais→origem só SSH→verificação real do artefato→devolução controlada, sem login IA no destino. |
| T26 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Finite expired-auth and incompatible-protocol fixtures must preserve work and refuse admission until confirmation; actual account expiry is optional validation. |
| T27 | R4 produto | do_not_accept_full_requirement | Timeout/reconnect mobile para início/pausa/retomada/política com efeito único por intenção e intenção nova distinta. |
| T28 | R4 produto | do_not_accept_full_requirement | Demonstrar bridge ou prevenção técnica de sobreposição entre ingressos antigos/novos e refresh/reservas sob falha/reversão. |
| T29 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Fill programmer ceiling then demand QA/reviewer/specialist; physical stage retirement frees exact slots; Saturated programmer to evaluator progress with actual provider capacity graph pending R3 |
| T30 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Restore an older backup while newer external workers remain alive; prove reconciliation and neutralization before dispatch and preservation of pauses in a disposable local lab. |
| T31 | R4 produto | do_not_accept_full_requirement | Compor capacidade desconhecida, sucesso recente sem saldo e probes concorrentes, verificando serialização/limites e nenhuma emergência indevida. |
| T32 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Update worker with pending messages/pauses/operations and Continue-As-New while retaining compatible old workers; Real pending update/Continue-As-New migration with old-worker retention absent; pinning alone is not update strategy proof |
| T33 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Invent test/truncate log/remove CI gate; trusted independent executor refuses integration; Independent execution of complete forged/truncated/gate-removal and external-writer races pending |
| T34 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Prepare successor while old writer lives; no shared writable copy before access/physical retirement; Remote escaped descendant neutralization and successor shared-worktree physical matrix pending R3 |
| T35 | R4 produto | do_not_accept_full_requirement | Comparar mesmas identidades/estados/responsáveis/atraso após correção durante suspensão e retorno da UI. |
| T36 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Direct API/WS/MCP/terminal admin attack denied; manager authorized project administration still works; Full cross-account shell/symlink/process/API plus central admin attack coverage remains unverified |
| T37 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Two context regular selections persist independently across restart and account disable under global contention; Two live contexts restart/disabled account state not independently rerun |
| T38 | R3 runtime + inventário R4 | historical_R3_only_not_new_acceptance | Policy waiver advances; canceled/lost/stale results block; artifact change invalidates old binding; Seven pure waiver cases rerun; integrated waiver revocation versus physical retirement race not rerun |
| T39 | R4 produto | do_not_accept_full_requirement | Após provar funcionalidade técnica em laboratório, marcar modo inelegível e demonstrar recusa pré-spawn sem alterar quota ou habilitar transporte/API alternativos. |
