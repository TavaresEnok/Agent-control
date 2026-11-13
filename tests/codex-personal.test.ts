import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {codexPersonalCommand,codexWorkerAssertsSubscriptionIdentity} from '../src/codex-personal.ts';
import {requireCodexAuthFile} from '../src/personal-combos.ts';
import {codexLimitFromText,isProviderLimit} from '../src/quota-exhaustion.ts';

test('personal Codex skips the subscription assertion and locked Codex keeps it',()=>{
 assert.equal(codexWorkerAssertsSubscriptionIdentity('codex'),false);
 assert.equal(codexWorkerAssertsSubscriptionIdentity('claude'),false);
 assert.equal(codexWorkerAssertsSubscriptionIdentity('grok'),false);
 assert.equal(codexWorkerAssertsSubscriptionIdentity(undefined),true);
});

test('personal Codex argv writes for the programmer and is read-only for the reviewer',()=>{
 const programmer=codexPersonalCommand({role:'programmer',model:'gpt-6.1-sol',effort:'max',prompt:'edit the checkout'});
 assert.deepEqual(programmer.env,['CODEX_HOME=/account/.codex']);
 assert.equal(programmer.args[0],'exec');
 assert.equal(programmer.args[programmer.args.indexOf('--sandbox')+1],'workspace-write');
 assert.equal(programmer.args[programmer.args.indexOf('--model')+1],'gpt-6.1-sol');
 assert.ok(programmer.args.includes('model_reasoning_effort=high'));
 assert.equal(programmer.args[programmer.args.indexOf('-C')+1],'/work');
 assert.equal(programmer.args.at(-1),'edit the checkout');
 const reviewer=codexPersonalCommand({role:'reviewer',model:'gpt-6.1-terra',effort:'high',prompt:'leia o diff',outputSchema:{type:'object'}});
 assert.equal(reviewer.args[reviewer.args.indexOf('--sandbox')+1],'read-only');
 assert.equal(reviewer.args[reviewer.args.indexOf('--model')+1],'gpt-6.1-terra');
 assert.ok(reviewer.args.includes('model_reasoning_effort=high'));
 assert.equal(reviewer.args[reviewer.args.indexOf('-C')+1],'/work');
 assert.match(String(reviewer.args.at(-1)),/ONLY one JSON object/);
 assert.match(String(reviewer.args.at(-1)),/leia o diff/);
 const qa=codexPersonalCommand({role:'qa',model:'gpt-6.1-sol',effort:'medium',prompt:'qa',outputSchema:{type:'object'}});
 assert.equal(qa.args[qa.args.indexOf('--sandbox')+1],'read-only');
 assert.equal(qa.args[qa.args.indexOf('-C')+1],'/work');
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
