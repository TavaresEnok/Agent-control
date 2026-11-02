from pathlib import Path
import csv
import json

root = Path(__file__).resolve().parent.parent
path = root / 'docs/validation/TRACEABILITY.csv'
with path.open(newline='') as stream:
    reader = csv.DictReader(stream)
    fields = reader.fieldnames
    rows = list(reader)

updates = {
    'RF-11': ('docs/validation/evidence/original-reserve-global-20261102.log', 'src/capacity.ts;tests/capacity.test.ts', 'Global original-account reserve admission tested with synthetic quotas; live providers and safe transition of running tasks remain open.'),
    'RF-18': ('docs/validation/evidence/isolated-verification-final-20261102.log', 'src/engineering.ts;src/isolated-verification.ts;src/sandbox-broker.ts;tests/engineering.test.ts', 'Independent synthetic verifier sessions in separate containers; real model reviews and provider accounts remain unverified.'),
    'RF-22': ('docs/validation/evidence/native-graph-recovery-final-20261102.log', 'src/cezar.ts;src/happier.ts;upstream/cezar/packages/cezar/src/workflows/run.ts;tests/native-recovery.test.ts', 'Native graph resumes after interrupted synthetic implementation; recovery of other nodes and real providers remains open.'),
    'RF-23': ('docs/validation/evidence/isolated-start-ack-recovery-20261102.log;docs/validation/evidence/broker-restart-neutralization-20261102.log;docs/validation/evidence/native-graph-recovery-final-20261102.log', 'src/isolated-implementation.ts;src/sandbox-broker.ts;src/cezar.ts;tests/native-recovery.test.ts;tests/isolated-recovery.test.ts', 'Controller SIGKILL after physical implementation result, successor reconciliation and native DAG continuation tested; other crash positions remain open.'),
    'RF-26': ('docs/validation/evidence/ssh-two-hosts-first-20261102.log;docs/validation/evidence/ssh-restart-persistence-20261102.log', 'src/remote.ts;services/remote-worker/worker.py;tests/ssh.test.ts;tests/ssh-restart.test.ts', 'Two disposable SSH hosts with no model credentials; remote AI CLIs and production hosts not evaluated.'),
    'RF-27': ('docs/validation/evidence/ssh-two-hosts-first-20261102.log;docs/validation/evidence/ssh-restart-persistence-20261102.log', 'src/remote.ts;services/remote-worker/worker.py;tests/ssh.test.ts;tests/ssh-restart.test.ts', 'Lost acknowledgement and completed receipt after host restart tested; interrupted in-flight effect remains open.'),
    'RF-28': ('docs/validation/evidence/isolated-verification-final-20261102.log', 'src/isolated-implementation.ts;src/isolated-verification.ts;src/sandbox-broker.ts;tests/engineering.test.ts', 'Fixed synthetic implementation and verifiers container-isolated; production bootstrap, hostile agents and real CLIs remain unverified.'),
    'RF-49': ('docs/validation/evidence/isolated-verification-final-20261102.log', 'src/isolated-verification.ts;src/sandbox-broker.ts;scripts/sandbox-verifier.mjs;tests/engineering.test.ts', 'Known controller paths unavailable to synthetic verifiers; real account credential isolation and broader hostile process proof pending.'),
    'RNF-03': ('docs/validation/evidence/isolated-verification-final-20261102.log', 'src/isolated-verification.ts;src/sandbox-broker.ts;tests/engineering.test.ts', 'Synthetic workers have no host socket, keys or network; verifier snapshots read-only. Hostile real agents and account boundaries not homologated.'),
    'T14': ('docs/validation/evidence/ssh-two-hosts-first-20261102.log;docs/validation/evidence/ssh-restart-persistence-20261102.log', 'src/remote.ts;tests/ssh.test.ts;tests/ssh-restart.test.ts', 'Real SSH and completed result after restart; interrupted in-flight operation still uncertain.'),
    'T15': ('docs/validation/evidence/isolated-verification-final-20261102.log', 'src/isolated-verification.ts;src/sandbox-broker.ts;scripts/sandbox-verifier.mjs;tests/engineering.test.ts', 'Fixed synthetic verifiers attempted snapshot writes and controller path access; cross-account hostile process proof pending.'),
    'T06': ('docs/validation/evidence/native-graph-recovery-final-20261102.log', 'src/cezar.ts;src/isolated-implementation.ts;tests/native-recovery.test.ts', 'Human pause preserved through successor reconciliation of synthetic implementation; full operator/mobile and concurrent pause cases remain open.'),
    'T08': ('docs/validation/evidence/native-graph-recovery-final-20261102.log;docs/validation/evidence/native-graph-recovery-red-20261102.log', 'src/cezar.ts;src/isolated-implementation.ts;upstream/cezar/packages/cezar/src/workflows/run.ts;tests/native-recovery.test.ts', 'Actual controller SIGKILL at one receipt boundary; fallback, cancellation and other node recovery positions remain open.'),
}
for row in rows:
    update = updates.get(row['id'])
    if update:
        row.update(status='partially_examined', code_state='partial', test_result='partial_scope_only', evidence=update[0], files=update[1], limitation=update[2])
assert len(rows) == 111 and len(updates) == 13
with path.open('w', newline='') as stream:
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
(root / 'docs/validation/TRACEABILITY.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')
