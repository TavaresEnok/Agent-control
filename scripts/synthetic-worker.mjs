// Fixed fixture only. This is not a user-command executor or production sandbox.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const operationId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(operationId)) throw Error('INVALID_OPERATION');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = git('rev-parse', 'HEAD');
writeFileSync(`synthetic-${operationId}.txt`, `Synthetic isolated effect ${operationId}\n`);
git('add', `synthetic-${operationId}.txt`);
git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic isolated implementation');
const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
writeFileSync(`receipt-${operationId}.json`, JSON.stringify({ operationId, base, commit, tree, exitCode: 0, synthetic: true }));
console.log('Synthetic implementation completed.');
