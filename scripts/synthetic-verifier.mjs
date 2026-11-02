// Fixed laboratory verifier. No provider, shell, key material or arbitrary command is accepted.
import { readFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
const [snapshot,operationId,role]=process.argv.slice(2);
if(!/^[a-f0-9-]{36}$/.test(operationId)||!['qa','review','judge'].includes(role))throw Error('INVALID_VERIFIER_ARGUMENT');
const source=readFileSync(join(resolve(snapshot),`synthetic-${operationId}.txt`),'utf8');
let passed;
if(role==='qa')passed=source===`Synthetic isolated effect ${operationId}\n`;
else passed=source.length<200&&source.startsWith('Synthetic isolated effect ')&&source.endsWith('\n')&&!source.includes('\0');
console.log(JSON.stringify({role,status:passed?'passed':'failed',checks:role==='qa'?['exact-fixture-result']:['fixture-format','size','no-nul'],synthetic:true}));
process.exit(passed?0:1);
