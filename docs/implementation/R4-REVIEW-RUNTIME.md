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
