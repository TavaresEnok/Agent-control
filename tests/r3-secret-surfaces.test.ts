import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

test('RNF08 finite private-custody canaries stay out of durable history, live APIs and exports',{timeout:30000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');const home=await mkdtemp(join(tmpdir(),'ac-r3-secret-child-'));
 try{
  const result=await promisify(execFile)(process.execPath,['--import','tsx','tests/fixtures/r3-secret-surfaces.ts'],{cwd:process.cwd(),timeout:25000,maxBuffer:32768,env:{HOME:home,PATH:'/tmp/node-v22.23.3-linux-x64/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',AC_TEST_DATABASE_URL:base,AC_R3_SECRET_TOKEN:'synthetic-host-'+randomBytes(24).toString('hex')}});
  const report=JSON.parse(result.stdout.trim());assert.equal(report.passed,true);assert.equal(report.secretSource,'synthetic-only-allowlisted-child');assert.ok(report.surfaces.length>=10);assert.equal(report.providerInference,false);assert.equal(report.executionDispatched,false);assert.equal(result.stderr,'');console.log(JSON.stringify(report));
 }finally{await rm(home,{recursive:true,force:true});}
});
