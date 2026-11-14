import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {codexPersonalCommand,codexWorkerAssertsSubscriptionIdentity,runCodexExec} from '../src/codex-personal.ts';
import {requireCodexAuthFile} from '../src/personal-combos.ts';
import {codexLimitFromText,isProviderLimit,providerLimitDisposition} from '../src/quota-exhaustion.ts';

test('personal Codex skips the subscription assertion and locked Codex keeps it',()=>{
 assert.equal(codexWorkerAssertsSubscriptionIdentity('codex'),false);
 assert.equal(codexWorkerAssertsSubscriptionIdentity('claude'),false);
 assert.equal(codexWorkerAssertsSubscriptionIdentity('grok'),false);
 assert.equal(codexWorkerAssertsSubscriptionIdentity(undefined),true);
});

test('personal Codex argv leaves sandboxing to the worker container for every role',()=>{
 const programmer=codexPersonalCommand({role:'programmer',model:'gpt-6.1-sol',effort:'max',prompt:'edit the checkout'});
 assert.deepEqual(programmer.env,['CODEX_HOME=/account/.codex']);
 assert.equal(programmer.args[0],'exec');
 assert.equal(programmer.args[programmer.args.indexOf('--sandbox')+1],'danger-full-access');
 assert.equal(programmer.args[programmer.args.indexOf('--model')+1],'gpt-6.1-sol');
 assert.ok(programmer.args.includes('model_reasoning_effort=high'));
 assert.equal(programmer.args[programmer.args.indexOf('-C')+1],'/work');
 assert.equal(programmer.args.at(-1),'edit the checkout');
 const reviewer=codexPersonalCommand({role:'reviewer',model:'gpt-6.1-terra',effort:'high',prompt:'leia o diff',outputSchema:{type:'object'}});
 assert.equal(reviewer.args[reviewer.args.indexOf('--sandbox')+1],'danger-full-access');
 assert.equal(reviewer.args[reviewer.args.indexOf('--model')+1],'gpt-6.1-terra');
 assert.ok(reviewer.args.includes('model_reasoning_effort=high'));
 assert.equal(reviewer.args[reviewer.args.indexOf('-C')+1],'/planning');
 assert.match(String(reviewer.args.at(-1)),/ONLY one JSON object/);
 assert.match(String(reviewer.args.at(-1)),/leia o diff/);
 const qa=codexPersonalCommand({role:'qa',model:'gpt-6.1-sol',effort:'medium',prompt:'qa',outputSchema:{type:'object'}});
 assert.equal(qa.args[qa.args.indexOf('--sandbox')+1],'danger-full-access');
 assert.equal(qa.args[qa.args.indexOf('-C')+1],'/planning');
});

test('a Codex limit text becomes PROVIDER_USAGE_LIMIT',()=>{
 const now=Date.parse('2026-11-13T12:00:00Z');
 const marked=codexLimitFromText(["ERROR: You've hit your usage limit. Try again at 2026-11-13T12:20:00Z"],now);
 assert.equal(marked?.failureCode,'PROVIDER_USAGE_LIMIT');
 assert.equal(isProviderLimit(marked?.failureCode),true);
 assert.equal(marked?.usageWindows?.provider,'codex');
 assert.equal(marked?.usageWindows?.source,'codex-notification');
 assert.equal(marked?.usageWindows?.windows[0]?.resetsAt,Date.parse('2026-11-13T12:20:00Z'));
 const plain=codexLimitFromText(["You've hit your usage limit."],now);
 assert.equal(plain?.failureCode,'PROVIDER_USAGE_LIMIT');
 assert.equal(plain?.usageWindows,null);
 assert.equal(codexLimitFromText(['the build failed for another reason'],now),null);
});

test('a Codex combo login is the .codex/auth.json file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-codex-login-'));
 try{
  await assert.rejects(requireCodexAuthFile(dir),(error:unknown)=>error instanceof Refusal&&error.code==='CODEX_LOGIN_REQUIRED');
  await mkdir(join(dir,'.codex'),{mode:0o700});
  await writeFile(join(dir,'.codex','auth.json'),'{}\n',{mode:0o600});
  await requireCodexAuthFile(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a Codex run that succeeds is never a limit, even when it read files that mention one',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-codex-run-'));
 try{
  const bin=join(dir,'codex');
  // Mimics codex exec: the transcript on stderr echoes a test file about rate limits, then the answer on stdout.
  await writeFile(bin,"#!/bin/sh\necho 'exec: cat failing-adapters.ts' >&2\necho \"throw new Error('rate limit exceeded; quota reached')\" >&2\necho 'Mapa criado.'\nexit \"${FAKE_EXIT:-0}\"\n",{mode:0o700});
  const previous=process.env.CODEX_BIN;process.env.CODEX_BIN=bin;
  try{
   const ok=await runCodexExec({args:[],timeoutMs:10000,cwd:dir,kind:'execution'});
   assert.equal(ok.failureCode,null);assert.match(ok.output,/Mapa criado/);
   process.env.FAKE_EXIT='1';
   const failed=await runCodexExec({args:[],timeoutMs:10000,cwd:dir,kind:'execution'});
   assert.equal(failed.failureCode,'PROVIDER_USAGE_LIMIT');
  }finally{delete process.env.FAKE_EXIT;if(previous===undefined)delete process.env.CODEX_BIN;else process.env.CODEX_BIN=previous;}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a limit hit again after the recorded reset waits again instead of restarting straight away',async()=>{
 let until:Date|null=null;
 const ledger={pool:{query:async(sql:string,params:any[])=>{
  if(sql.startsWith('SELECT'))return {rows:[{exhausted_until:until}]};
  const next=new Date(params[1]);if(!until||until<next)until=next;return {rows:[]};
 }}} as any;
 const start=Date.now();
 assert.equal(await providerLimitDisposition(ledger,'a','PROVIDER_USAGE_LIMIT',null,start,start),'wait');
 const reset=until!.getTime();
 // After the reset, the same old observation lets the job run again.
 assert.equal(await providerLimitDisposition(ledger,'a','PROVIDER_USAGE_LIMIT',null,reset+1000,start),'resume');
 // The restarted job hits the limit again: that is a new limit, so it waits for a new reset.
 assert.equal(await providerLimitDisposition(ledger,'a','PROVIDER_USAGE_LIMIT',null,reset+60000,reset+30000),'wait');
 assert.equal(await providerLimitDisposition(ledger,'a',null,null,reset+60000,reset+30000),'seal');
});
