# R4 independent runtime review

Review base: `c24cefb1`. Independent reviewer owns this report and review-only probes; production changes belong to their authors and root is sole integrator. No complete-requirement acceptance follows from a module decision.

## Finite acceptance matrix (initial review)

| Scope | Required observation | Initial decision |
| --- | --- | --- |
| Native resources 081 | Durable admission before create, immutable group ID and verified kernel parent, conservative uncertainty after lost ACK | Pending final version and physical probe |
| Native resources 081 | Cancellation/restart before native job journal drains only after host absence proof; product reconciliation caller exists | Pending: exported reconciliation methods currently lack caller |
| Native resources 081 | Preparation failure after admission cannot release SQL grant while leaking host reservations | Finding sent: QA snapshot failure releases grant without canceling pending host slot |
| Remote product API | Concurrent authenticated calls at pool capacity progress without nested-client starvation | Pending author correction and finite concurrent probe |
| Remote product API | Profile write paths constrain intent paths before emission; normalized paths cannot escape configured directory by traversal | Pending author correction; initial prefix subset patch requires normalization |
| Remote product API | Human signature, current owner/manager, conflict and replay guards preserve fixed effect identity | Pending final delta review |
| Combined flow | Actual product paths exercise 079/080/081 with live work through interruption, takeover/cancellation and terminal proof | Pending final artifact, after prerequisites approved |

The R3 approved immutable group helper and resource authority remain approved only at their recorded versions/scopes. WIP 081 is not promoted by reuse of those earlier proofs. Remote API R3 blockers are local executable gaps, not external-account prerequisites. Identified disposable labs only; no operational migration, paid inference, real account, or deployment is authorized.

## Remote API correction: approved bounded scope

`5e223504` + `231c4f77` + `796972d8` **approved for integration for the synthetic fixed-task product API and the two R3 blocker corrections**. Independent reexecution in this review worktree: Node22.23.3, `tests/r3-delivery-product-api.test.ts`, **2/2 passed, zero skips**, log `r4-review-runtime-remote-api.log`. Fixture used a newly named child database in the author's identified disposable PG and its own SSH/Docker resources; cleanup completed.

The decisive concurrency barrier held eight human-authority transactions simultaneously before all eight requested a shared adapter connection; all reached the explicit expected409 sentinel with zero shared-pool waiters. Two simultaneous same-intent preparations returned identical200 results; changed semantics received conflict. The actual signed gateway then prepared a source, launched SSH/Docker output under live manager authority and registered the resulting artifact as unreviewed. No approval or integration was inferred from registration.

The isolated human transaction retains signature/membership/advisory locks on a separate bounded-time connection while adapter work uses the shared pool. This removes the observed max8 shared-pool hold-and-wait cycle; one additional connection per in-flight request remains a database capacity consideration, not a throughput guarantee. Canonical path validation rejects traversal, dot/git components, repeated separators, absolute paths, backslashes and control bytes before directory-prefix comparison. The launch rejects configured-profile expansion and releases only a still-reserved not-started grant on this validation failure. These changes constrain declared intent paths; fixed executable behavior is additionally checked against the sealed snapshot before artifact registration.

This decision does **not** include the subsequent079 environment source/host/task hooks, later combined-flow versions, real provider accounts, or general UI/browser acceptance. Those deltas require their own explicit review.

## Native081: independent observation, overall decision pending

Independent reexecution of `51b8512e` + `67b49baf` + `79549a7b`: `tests/r3-native-resource-envelope.test.ts`, Node22.23.3, **1/1 passed, zero skips**, about73s, log `r4-review-runtime-resource081.log`. The disposable author's PG hosted only the fixture's new isolated database. The fixture provisioned its own random anchor/authority and Docker groups and completed cleanup.

Observed two real Capacity-backed controllers under the same physical parent, CPU throttling and PIDs refusal, SQL uncertainty after controller SIGKILL while its immutable group remained alive, stopped/removed groups freeing physical slots, exact retired-name replay refusing a substitute, nativeQA waiting before journal while full, signed cancellation and pause/resume. The new prejournal controller was physically killed after durable batch admission; successor reconciliation removed only its pending reservations using host absence proof, and stale/foreign requests left admissions and grants unchanged. This focused takeover fixture explicitly expires its own manager lease in SQL before acquiring the successor; it is a fence/recovery test, not evidence of waiting for real expiry. The combined-flow proof must demonstrate actual lease expiry.

Static corrections examined: nonce commits before host admission; every host attempt and cleanup holds the context fence; cleanup errors retain uncertainty; canceled admissions precede grant release; the Cezar cancellation tick calls supervisor admission reconciliation before generic release; reconciliation pages through the existing history cursor. QA definite snapshot-preparation failure now calls host absence cleanup before release.

**Overall081 integration approval remains pending**: a native job journal can exist before its first Docker create. Planning/execution recovery for controller death in that interval still needs explicit retirement of the pending no-ID host reservations; otherwise bridge absence conservatively refuses and strands capacity. The author owns this follow-up. Green prejournal evidence is not acceptance of the missing postjournal crash case or of every native lane through the combined runtime.

## Bootstrap613880ef: custody counterproof, approval withheld

The supplied schema test independently passed1/1. An additional review-only disposable-filesystem probe (`tests/r4-review-bootstrap-parent-link.test.ts`) **confirmed** that `dataDirectory/link/verifier`, where `link` targets the configured project repository, is accepted by `Installation` and read successfully by `readPrivateFile` when the synthetic leaf is owned/private. `resolve` checks lexical normalization; `O_NOFOLLOW` on the leaf does not reject a symlink parent. Log `r4-review-runtime-bootstrap-counterproof.log`. No real key, account, network service or external repository was accessed.

Therefore613880ef is **not approved as complete guarded bootstrap custody** until actual canonical parent/file containment is validated before verifier loading. The source of the verifier must remain outside writable repositories/roots after following filesystem links. This is a concrete local correction; no user credential is needed to demonstrate it. Other bootstrap constraints (explicit synthetic mode, configured project, isolated tmpfs and SSH paths) remain supported by the focused schema test, subject to the same distinction between lexical and filesystem identity.

The resource probe's fixture left its private installation binding after retiring groups/anchor. The reviewer identified its own random installation and exact anchor by creation interval, confirmed all owned groups/anchor absent and safe exact binding/lock identities, then retired only those two files and directory. The author was informed to close the fixture cleanup gap; preexisting author bindings were preserved.

## Bootstrap custody correction85858161: approved bounded scope

`613880ef` + `85858161` **approved for guarded synthetic bootstrap wiring/custody**. The remote development factory now explicitly requests canonical loading; the opened descriptor, resolved filesystem path and configured normalized path must agree before bytes are read. This closes the demonstrated parent-link alias. The reviewer inverted the independent exploit probe into a rejection regression and ran it alongside both supplied bootstrap tests: **3/3 passed, zero skips**, log `r4-review-runtime-bootstrap-final.log`.

The server wires this opt-in factory to the project's active manager transport and the previously reviewed signed administration API. Absence remains disabled, and startup schema confines project IDs, verifier custody and temporary working roots. Materialization separately checks owned private real tmpfs and the128MiB ceiling at use. This decision supersedes the prior custody rejection only for these pinned versions and the demonstrated scope; it does not claim an operational server deployment, official provider activation, or acceptance of pending delivery079/081/UI deltas.

## Delivery079 physical hooksb69e5a51: approved

`b69e5a51` over the reviewed API correction and environment storage/gates (`41995a7b` + `01db4b8b` + `e4182254` + `09b9e3e3`, with directory-notation correction `21dc9f3d`) **approved for the synthetic remote product/backend scope**. Independent sequential reexecution of API, workspace and return files: **8/8 passed, zero skips**, log `r4-review-runtime-delivery-environments.log`. This repeated the affected physical lanes because the new gates change their launch/return behavior.

Observed signed API prepare→launch→unreviewed registration, one SSH/Docker writer and exact sealed replay, real Git/SSH return with signed approval/CAS/lost-ACK receipt, late quota no-effect release, durable emission on lost ACK, shared-pool saturation, and a configured source-directory replacement with a symlink between binding and emission. The latter was refused at the final gate with `PROJECT_ENVIRONMENT_FILESYSTEM_CHANGED`, durable `no_effect`, released reserved grant and no remote execution claim. Missing configured environment is refused before workspace journal. Return approval remains the existing separately verified gate, not a property of registration.

Static review confirms fixed-task host/task/write-path snapshot commits before the environment execution-contract trigger; final emission validates its digest, selected profile binding, current environment destination and frozen source before the durable emitting marker. Prepare, snapshot and return also recheck their required environment authority. This is synthetic fixed-executable execution with real local transport/process effects, not official inference, an enabled deployment, or acceptance of unrelated browser/navigation criteria.

##081 postjournal/source-routing and planner retirement review

`2425575f` + `4ad29d7d` source review resolves the previously recorded postjournal no-create and normal planner-slot retirement findings. Pending admission cleanup now requires host proof that no group and no create claim exist. Execution releases its SQL grant only after additionally retiring the known immutable private network; unknown network identity preserves uncertainty. QA preparation/interruption records missing-result evidence, not passed verification. Source-specific history lanes refuse foreign native job dispatch and drop released terminal admissions from active revisits.

The native planning executor exposes a trusted retirement callback. SemanticPlanning invokes it after proposal publication commits, including replay after lost cleanup ACK; signed receipt/output files remain available. Native cleanup checks immutable ID, exit/time and signed physical receipt, then verifies both name and ID absent. No fixture is allowed to manufacture this cleanup in the combined proof.

Independent PG-only reexecution of `tests/r4-native-resource-routing.test.ts` and `tests/semantic-planning.test.ts`: **2/2 passed, zero skips**, log `r4-review-runtime-resource-followup-pg.log`. This verifies actual SQL routing/history and commit-before-retire/replay, using a deliberately forbidden host stub in the routing test and a signed fixture planner in the semantic test. It is not a new physical Docker run. A single final combined physical proof is queued by root; overall081 acceptance still depends on that proof and on any new combined cancellation gaps.

## Broker429a0bf2 lifecycle and composed isolation proof: approved bounded scope

`429a0bf2` production shutdown correction and `a30c2a91` adversarial proof source **approved in the stated broker scope**. Independent source review examined the lifecycle flag, complete composed test, hostile payload and exact lock-loss subprocess. Root coordinated one serialized author execution; the reviewer inspected its final raw log: **1/1 passed, file exit0, zero skips**. Copied provenance is `r4-review-runtime-broker-author-observed.log`; this is **author execution observed/reviewed**, not an independent rerun. A second heavy run adds no required source change coverage here.

Two real broker-created UID10001 workers concurrently execute42 checks each (41 refused attacks plus a permitted local read/write control) while a legitimate signed owner environment mutation succeeds in an authorized idle project. Direct files, symlink attempts, shell, PID/proc, sockets and network are covered finitely. Worker network denial is correctly distinguished from host401/403 authentication counterprobes. Canary/project refs and central administrator records remain unchanged; grants release after legitimate terminal receipts and owned cleanup. This is a broker fixture, not complete native/SSH isolation acceptance.

The production correction marks expected shutdown before releasing the advisory lock, preserving existing process failure status. An unexpected error/end still closes admission and produces exit1. The final test verifies ordinary stop preserves exitCode and terminates the actual exact PostgreSQL advisory-lock backend in an isolated child; that child exits1. The old passing-subtest/file-exit1 artifact remains historical negative evidence, superseded only by this corrected version.

## RF21 restart/probe evidence9ef5aa80: accepted as bounded evidence only

The reviewer read both restart fixture sources and the author's3/3 zero-skip log, copied as `r4-review-runtime-provider-restart-author.log`; no independent restart rerun was requested while heavy work was serialized. The proof exercises real PostgreSQL and separate collector processes. Transport failures produce only one read-only probe per persisted minimum interval across restarts; the test explicitly ages fixture clocks to enter three further intervals. Unconfirmed timeout and crashed/expired-lease collectors remain quarantined and create no second effect. Synthetic registry version changes, unknown/auth-required observations and unknown model denial preserve the queued intent and prevent worker launch.

**The artifact is acceptable for those finite claims; fullRF21 remains unaccepted by this review.** It does not implement or prove a total lifetime recovery budget during persistent outage, measure inference consumption, populate/recover canonical ciphertext history, or validate the actual official CLI protocol. The separate native protocol verifier/promotion084 remains pending lifecycle correction and physical evidence; its initial random-container/finally-only cleanup cannot be approved against controller SIGKILL.

##0863244e520: second-successor counterproof, approval withheld

A review-only PostgreSQL/Git probe derived from the author's fixture independently confirms a liveness gap: manager1 holds a writer and durable prejournal admission; manager2 proves host absence, cancels admission/releases grant and records a continuation; manager2 dies before making a new attempt. Manager3's reconciliation skips the canceled/released admission and its exact-epoch writer claim remains `WORKTREE_WRITER_BUSY`, with no continuation for manager3. **1/1 counterproof passed, zero skips**, log `r4-review-runtime-writer-multihop-counterproof.log`; this pass demonstrates the defect. Host absence is an explicitly injected receipt in this state-machine probe; no Docker workload ran.

`3244e520` **approval withheld** until repeated succession across this gap is supported and proven. Its unique admission nonce currently also prevents another continuation from the same already-proven no-create interval. The author separately identified terminal native retirement's epoch comparison needing exact continuation recognition. Neither is repaired by rewriting the original writer epoch or by a one-successor happy path; the original identity must remain immutable, and unknown effects must remain blocking.

##086 multihop correction50ad40ae and rejected planner retiremente305acaa

`3244e520` + `50ad40ae` **approved for integration in the bounded managed-writer state/recovery scope**; `e305acaa` **approved for terminal rejected-planner retirement source/state ordering**. This supersedes the preceding086 rejection at its exact versions. The independent counterproof was inverted into a success regression, then run with the expanded author unstarted-recovery file and semantic planning: **5/5 passed, zero skips**, log `r4-review-runtime-writer-final-pg.log`.

Repeated successors now recheck host absence under the current fence while a registered managed operation still holds its original writer, even if the old admission/grant is canceled/released or the operation has cleared/replaced that grant before admitting again. Continuations are unique per nonce and successor epoch; the immutable original holder/parent/run/epoch remains unchanged. Unknown host evidence blocks continuation and stale managers remain fenced. The expanded fixture covers further cleanup→claim, grant-cleared and reserve-before-admit cuts, terminal cancellation waiting for the held writer, and eventual neutralization. Host receipts are explicitly injected for these PG/Git state-machine proofs.

Native terminal writer retirement uses the same exact continuation verifier when job epoch differs from original writer epoch, and includes its digest in signed revocation evidence. This source predicate has been reviewed; physical exercised continuation/retirement remains part of integration evidence, not asserted from the PG fixture. Rejected signed planner results now invoke trusted cleanup only after rejected state commits, including replay, preserving the signed result and requiring no new inference.

No084/085 protocol module is a dependency of086. Overall combined081/086 physical-flow acceptance remains pending the single final coordinated run.

## Remote candidate projectiona9f196fd: approved

`a9f196fd` **approved for the read-projection contract**. Independent PostgreSQL test `tests/r4-remote-source-candidates.test.ts`: **1/1 passed, zero skips**, log `r4-review-runtime-source-candidates.log`. The test deliberately seeds projection inputs; it is not a new SSH/materialization execution.

The projection may offer a new live-epoch export only when its project/context/host/commit/tree match the immutable materialized source, its request digest is exact, its intent has matching human-signed source authorization and current implementation epoch, and it is uncanceled and not already bound to a workspace. Wrong commit/tree/digest/epoch and unsigned exports remain invisible; the original materialization operation identity is unchanged. Candidate display grants no new effect authority: the existing prepare and final emission gates still revalidate source, manager and environment. Full canonical browser execution remains a separate pending proof.

##082954fca20 generation backend: approved bounded scope

`954fca20` **approved for the compatible local generation registry/fences/continuation backend**. Independent `workflow-generations` plus `workflow-versioning` run: **10/10 passed, zero skips**, about55s, log `r4-review-runtime-workflow-generations.log`. Tests create a UUID child database in the author's identified disposable PG, load two actual source packages/Cezar classes with different measured bytes, and close their own stores/processes/databases.

The local capability measures the executed Node, installed source/Cezar bytes and PID/start identity; no JSON caller can announce arbitrary build/digest/PID claims. Project/default admission locking and explicit legacy retention preserve old routes. Atomic request-id replay, immutable generation continuity and manager epoch change fence the predecessor without cloning run/intent/op/outbox/messages or fabricating an external result. The context-wide barrier now covers descendants, stage/grant/native/remote journals and held writers. Historical081 admitted rows cease blocking only with matching trusted terminal evidence/required retirement; unresolved prejournal or missing retirement still block. A retained stopped planning group is terminal-process evidence, not a claim of physical group retirement.

Observed real subprocess death before/after transaction commit, a real old fenced writer stopping, lost ACK replay, paused/message/outbox/uncertain-op preservation, incompatible/missing/expired route refusal, and paging. The large modern RunStore case retained10000events/3057784bytes, reopened using the successor package with zero full-transcript reads and65536tail bytes, then appended seq10001 at the same graph cursor. This supports bounded modern recovery without inventing a need to truncate the canonical transcript; legacy index repair and standalone fallback costs remain explicitly outside this result.

**FullRF52/T32 acceptance remains pending delivered bootstrap/caller integration**: real runtime registration/renewal, correct package dispatch and RunStore owner shutdown/reopen must use this backend, and existing unrelated pending intents must remain parked/routed rather than failed. The backend does not launch/kill/remove old executable packages. Follow-up per-intent Happier/Cezar consumers and root bootstrap are separate versioned review scopes.
