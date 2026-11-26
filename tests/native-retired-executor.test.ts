// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import type {Ledger} from '../src/ledger.ts';

test('a supervisor kept for a replaced image pair reconciles old jobs but never launches a new one',async()=>{
 const area=await mkdtemp(join(tmpdir(),'ac-retired-')),pem=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString();
 const ledger={pool:{query:async()=>({rows:[],rowCount:0})}} as unknown as Ledger,account=randomUUID();
 const config=(active?:boolean)=>({id:'personal-execution-codex',workerImage:'sha256:'+'1'.repeat(64),toolsImage:'sha256:'+'2'.repeat(64),hostRoot:join(area,'host'),accountRoot:join(area,'accounts'),
  protectedRepositories:[],signingKeyPem:pem,providerNetworkId:'e'.repeat(64),socketPath:'/no-socket',provider:'codex' as const,accountSubjects:[{accountId:account,subjectDigest:'a'.repeat(64)}],workerEnv:[],toolsEnv:[],...(active===undefined?{}:{active})});
 const current=new NativeExecutionSupervisor(ledger,config()),retired=new NativeExecutionSupervisor(ledger,config(false));
 assert.equal(current.active,true);assert.equal(retired.active,false);assert.equal(retired.supportsAccount(account),true);
 const request={jobId:randomUUID(),intentId:randomUUID(),grantId:randomUUID(),sessionId:randomUUID(),base:'a'.repeat(40),role:'reviewer' as const,task:'review',writePaths:[],artifactId:randomUUID(),outputSchema:{type:'object'}};
 await assert.rejects(retired.start('owner',{contextId:randomUUID(),epoch:1,token:'t'} as never,request),/NATIVE_EXECUTOR_RETIRED/);
});
