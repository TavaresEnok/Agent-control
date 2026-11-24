import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {verifyCliExitCode,VERIFY_TRANSIENT_EXIT} from '../src/personal-verify-cli.ts';

test('only a busy Docker is a transient verify failure',()=>{
 assert.equal(verifyCliExitCode(new Refusal('DOCKER_UNCERTAIN')),VERIFY_TRANSIENT_EXIT);
 assert.equal(verifyCliExitCode(new Refusal('DOCKER_CREATE_UNCERTAIN')),VERIFY_TRANSIENT_EXIT);
 assert.equal(verifyCliExitCode(new Refusal('VERIFY_EXAM_INCOMPLETE')),1);
 assert.equal(verifyCliExitCode(new Refusal('PROVIDER_USAGE_LIMIT')),1);
 assert.equal(verifyCliExitCode(new Error('x')),1);
});

async function launch(plan:number[],retries:string){
 const dir=await mkdtemp(join(tmpdir(),'ac-verify-retry-'));
 const counter=join(dir,'n'),fake=join(dir,'fake.mjs');
 await writeFile(counter,'0');
 await writeFile(fake,`import {readFileSync,writeFileSync} from 'node:fs';const n=Number(readFileSync(${JSON.stringify(counter)},'utf8'));writeFileSync(${JSON.stringify(counter)},String(n+1));process.exit(${JSON.stringify(plan)}[n]??0);`);
 const result=spawnSync(process.execPath,[resolve('scripts/personal-verify.mjs'),'a','b'],{encoding:'utf8',env:{...process.env,AC_VERIFY_CLI_FOR_TESTS:fake,AC_VERIFY_RETRIES:retries,AC_VERIFY_RETRY_PAUSE_MS:'0'}});
 const calls=Number(await readFile(counter,'utf8'));await rm(dir,{recursive:true,force:true});
 return {status:result.status,calls,stderr:result.stderr};
}

test('npm run personal:verify starts a new attempt after a transient failure, up to the limit',async()=>{
 let r=await launch([75,75,0],'3');assert.equal(r.status,0);assert.equal(r.calls,3);assert.match(r.stderr,/tentativa 2 de 4/);
 r=await launch([75,75,75,75,75],'3');assert.equal(r.status,1);assert.equal(r.calls,4);
 r=await launch([1,0],'3');assert.equal(r.status,1);assert.equal(r.calls,1);
 r=await launch([75,0],'0');assert.equal(r.status,1);assert.equal(r.calls,1);
});
