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
    'RF-23': ('docs/validation/evidence/isolated-start-ack-recovery-20261102.log;docs/validation/evidence/broker-restart-neutralization-20261102.log;docs/validation/evidence/isolated-successor-recovery-20261102.log', 'src/isolated-implementation.ts;src/sandbox-broker.ts;src/cezar.ts;tests/engineering.test.ts;tests/broker-recovery.test.ts;tests/isolated-recovery.test.ts', 'Lost start acknowledgement, simulated broker restart fencing and successor artifact reconciliation tested; automatic native DAG continuation after crash remains open.'),
    'RF-26': ('docs/validation/evidence/ssh-two-hosts-first-20261102.log;docs/validation/evidence/ssh-restart-persistence-20261102.log', 'src/remote.ts;services/remote-worker/worker.py;tests/ssh.test.ts;tests/ssh-restart.test.ts', 'Two disposable SSH hosts with no model credentials; remote AI CLIs and production hosts not evaluated.'),
    'RF-27': ('docs/validation/evidence/ssh-two-hosts-first-20261102.log;docs/validation/evidence/ssh-restart-persistence-20261102.log', 'src/remote.ts;services/remote-worker/worker.py;tests/ssh.test.ts;tests/ssh-restart.test.ts', 'Lost acknowledgement and completed receipt after host restart tested; interrupted in-flight effect remains open.'),
    'RF-28': ('docs/validation/evidence/isolated-engineering-second-20261102.log', 'src/isolated-implementation.ts;src/sandbox-broker.ts;tests/engineering.test.ts', 'Only fixed synthetic implementation is container-isolated; QA and real CLIs are not.'),
    'RNF-03': ('docs/validation/evidence/isolated-engineering-second-20261102.log', 'src/isolated-implementation.ts;src/sandbox-broker.ts;tests/engineering.test.ts', 'Synthetic worker has no host socket, keys or network; hostile agents and all roles not demonstrated.'),
    'T14': ('docs/validation/evidence/ssh-two-hosts-first-20261102.log;docs/validation/evidence/ssh-restart-persistence-20261102.log', 'src/remote.ts;tests/ssh.test.ts;tests/ssh-restart.test.ts', 'Real SSH and completed result after restart; interrupted in-flight operation still uncertain.'),
    'T15': ('docs/validation/evidence/isolated-engineering-second-20261102.log', 'src/isolated-implementation.ts;src/sandbox-broker.ts;tests/engineering.test.ts', 'Fixed synthetic implementation only; cross-account hostile process proof pending.'),
}
for row in rows:
    update = updates.get(row['id'])
    if update:
        row.update(status='partially_examined', code_state='partial', test_result='partial_scope_only', evidence=update[0], files=update[1], limitation=update[2])
assert len(rows) == 111 and len(updates) == 7
with path.open('w', newline='') as stream:
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
(root / 'docs/validation/TRACEABILITY.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')
