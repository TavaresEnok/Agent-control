# Real Happier notifications and context-export v2 composition

The existing R3 conversation flow already executes a real completion publication, loses its ACK after the server writes, observes one canonical completion despite the managed children, restarts the endpoint and reads the same completion. Its R4 owner adds explicit receipt/localId/ciphertext and child-notification assertions to that existing flow, avoiding another inference run. This separate lightweight proof covers the remaining multi-parent grouping and newly changed CLI composition with canonical encrypted history.

`tests/r4-notifications-cli-happier.test.ts` starts one local real Happier SQLite server through the existing provenance-pinned RecoveryHappier fixture. It compares1164 vendored source files byte-for-byte with the trusted preexisting dependency cache and verifies the source hash before startup. There is no model, provider call, Docker worker, bundler or official account. The local anonymous challenge identity, machine, session, E2EE key, PostgreSQL child database and directory are all disposable.

The test uses the actual native session socket transport and the same real idle-runtime snapshot claim as production before transcript publication. Two parent completions plus one immediate blocker become two encrypted outbox messages. A repeated semantic observation is deduplicated. The completion's actual server ACK is discarded after its write; PostgreSQL keeps it unsent. The first socket disconnects, a new real socket establishes runtime ownership, and a new Notifications instance retries the identical ciphertext/localId. The server returns `didWrite:false` with the same message ID/sequence/localId, which match the immutable PostgreSQL publication receipt. No second canonical completion is added.

Another151 encrypted canonical messages make the real CLI fetch two history pages,153 messages total. The actual `exportContext()` emits its version2 file with all messages in sequence, original local IDs, encrypted ciphertext and no key. Metadata includes a single64-task plan, each with64 scopes, whose redacted record exceeds256KiB and therefore requires byte continuation, plus a full ordered regular/emergency capacity policy. Those plan/policy rows are explicit metadata/controller fixtures, not admitted work: there are no accounts, grants, accepted execution intents, workers or inference results. CLI output verifies source digests, complete scopes/policy and absence of plaintext, token and key canaries. Output mode is0600. A second export refuses the preexisting destination (`EEXIST`) without changing it; both success and failure leave zero temporary export snapshots.

Author final result: Node22.23.3, **1/1 passed, zero skips**,16.79s test/20.00s total. Evidence `docs/validation/evidence/r4-notifications-cli-happier-author.log`. Normal TypeScript typecheck passed. Initial preparation and fixture trials were not counted as passes: missing dependency links were installed with the existing manifest helper, a bare socket was correctly refused before the production runtime-owner handshake was added, and a fixture policy INSERT was changed to name its columns. No product bug or product source change was required.

Reproduce from this worktree with existing root/cezar dependencies and the pinned Node:

```sh
mkdir -p upstream/happier/node_modules/@happier-dev
node scripts/link-happier-test-deps.mjs install /tmp/ac-close-base/upstream/happier /tmp/UNIQUE-r4-notice-deps.json
AC_TEST_DATABASE_URL=postgres://postgres:LAB_PASSWORD@127.0.0.1:LAB_PORT/ac_implementation_test node --import tsx --test --test-concurrency=1 tests/r4-notifications-cli-happier.test.ts
node scripts/link-happier-test-deps.mjs remove /tmp/UNIQUE-r4-notice-deps.json
```

The fixture timeout is60s and it stops/verifies its own service process group, closes its socket, drops only its random child database and removes its own directory. The author's labeled PostgreSQL base is retained temporarily for independent review; it is not an operational database. This test is not an Android/device proof, full backup/restore, physical-worker journey, general RPO/RTO benchmark or independent approval of RF35/RNF15. Independent review must assess those literal criteria with the existing flow and portability evidence together.
