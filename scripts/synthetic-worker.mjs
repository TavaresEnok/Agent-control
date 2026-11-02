// Fixed fixture only. This is not a user-command executor or production sandbox.
import { writeFileSync, lstatSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const operationId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(operationId)) throw Error('INVALID_OPERATION');
const outputPath=process.argv[3]??`synthetic-${operationId}.txt`;
if(!/^(?!\.)(?!.*(?:^|\/)\.)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(outputPath)||outputPath.length>240)throw Error('INVALID_OUTPUT_PATH');
const parts=outputPath.split('/');let directory='.';
for(const part of parts.slice(0,-1)){directory+=`/${part}`;try{const entry=lstatSync(directory);if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('INVALID_OUTPUT_PATH');}catch(error){if(error.code!=='ENOENT')throw error;mkdirSync(directory);}}
try{const entry=lstatSync(outputPath);if(!entry.isFile()||entry.isSymbolicLink())throw Error('INVALID_OUTPUT_PATH');}catch(error){if(error.code!=='ENOENT')throw error;}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const base = git('rev-parse', 'HEAD');
let content=`Synthetic isolated effect ${operationId}\n`;
if(process.argv[4]!==undefined){
 if(process.argv[4]!=='--correction'||!process.argv[5]||process.argv.length!==6)throw Error('INVALID_CORRECTION');
 const correction=JSON.parse(Buffer.from(process.argv[5],'base64').toString('utf8'));
 if(correction.outputPath!==outputPath||!/^[a-f0-9]{40}$/.test(correction.priorCommit)||!/^[a-f0-9]{40}$/.test(correction.priorTree)||
   !/^[a-f0-9]{64}$/.test(correction.decisionDigest)||git('rev-parse','refs/agent-control/correction-source')!==correction.priorCommit||
   git('rev-parse',`${correction.priorCommit}^{tree}`)!==correction.priorTree)throw Error('INVALID_CORRECTION');
 const previous=execFileSync('git',['show',`${correction.priorCommit}:${outputPath}`],{maxBuffer:1000000});
 content=`Synthetic corrected effect ${operationId}\nPrior content sha256 ${createHash('sha256').update(previous).digest('hex')}\nDecision ${correction.decisionDigest}\n`;
}
writeFileSync(outputPath,content);
git('add', '--', outputPath);
git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic isolated implementation');
const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
writeFileSync(`receipt-${operationId}.json`, JSON.stringify({ operationId, base, commit, tree, exitCode: 0, synthetic: true }));
console.log('Synthetic implementation completed.');
