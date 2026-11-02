// Fixed fixture only. This is not a user-command executor or production sandbox.
import { writeFileSync, lstatSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const operationId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(operationId)) throw Error('INVALID_OPERATION');
const outputPath=process.argv[3]??`synthetic-${operationId}.txt`;
if(!/^(?!\.)(?!.*(?:^|\/)\.)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(outputPath)||outputPath.length>240)throw Error('INVALID_OUTPUT_PATH');
const parts=outputPath.split('/');let directory='.';
for(const part of parts.slice(0,-1)){directory+=`/${part}`;try{const entry=lstatSync(directory);if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('INVALID_OUTPUT_PATH');}catch(error){if(error.code!=='ENOENT')throw error;mkdirSync(directory);}}
try{const entry=lstatSync(outputPath);if(!entry.isFile()||entry.isSymbolicLink())throw Error('INVALID_OUTPUT_PATH');}catch(error){if(error.code!=='ENOENT')throw error;}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = git('rev-parse', 'HEAD');
writeFileSync(outputPath, `Synthetic isolated effect ${operationId}\n`);
git('add', '--', outputPath);
git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic isolated implementation');
const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
writeFileSync(`receipt-${operationId}.json`, JSON.stringify({ operationId, base, commit, tree, exitCode: 0, synthetic: true }));
console.log('Synthetic implementation completed.');
