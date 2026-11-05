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
