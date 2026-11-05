import {test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes,randomUUID} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {resolve} from 'node:path';
import {CodexAppServerRunner} from '../upstream/cezar/packages/cezar/dist/core/codex-app-server-runner.js';
import {reconstructedFields} from './fixtures/r4-secret-surface-oracles.ts';
import {StreamRedaction} from '../upstream/cezar/packages/cezar/dist/runs/stream-redaction.js';

test('external auth registers each token before delivery and rejects absent refresh authority',{timeout:20000},async()=>{
 const dir=await mkdtemp('/tmp/ac-external-auth-'),bin=resolve('tests/fixtures/r5-external-auth/codex.mjs');
 try{for(const mode of ['authorized','absent','wrong-account','registration-fails','timeout'] as const){
  const initial='initial-'+randomBytes(24).toString('hex'),next='refresh-'+randomBytes(24).toString('hex'),registered:string[]=[],events:unknown[]=[],nativeEvents:{type:string}[]=[];const redactor=new StreamRedaction();
  const runner=new CodexAppServerRunner({bin,timeoutMs:10000});const session=runner.startSession({sessionId:randomUUID(),cwd:dir,userPrompt:'safe request',model:'fixed',reasoningEffort:'medium',isolatedAppServer:true,
   executionEnvironment:{id:'job_tools',url:'ws://127.0.0.1:19492',authBearerToken:'x'.repeat(48),cwd:'/work'},
   externalCodexAuth:{accessToken:initial,accountId:'synthetic-account',planType:null,registerSecret:async token=>{if(mode==='registration-fails'&&token===next)throw Error('registration refused');registered.push(token);},...(mode!=='absent'?{refresh:async()=>mode==='timeout'?await new Promise<never>(()=>{}):({accessToken:next,accountId:mode==='wrong-account'?'other-account':'synthetic-account',planType:null})}:{})}
  },event=>{nativeEvents.push(event);}, {autoEndAfterFirstTurn:true,onUiEvent:event=>{events.push(redactor.transform('run',event as any,registered));}});
  const result=await session.result;assert.deepEqual(registered,mode==='authorized'?[initial,next]:[initial]);
  if(mode==='authorized'){assert(result.text.includes(next));const fields=reconstructedFields(events,'run');assert(fields.size>0);assert([...fields.values()].some(value=>value.includes('[REDACTED]')));assert([...fields.values()].every(value=>!value.includes(next)));}else{assert(!result.text.includes(next));assert(nativeEvents.some(event=>event.type==='error'));}
 }
 console.log(JSON.stringify({runner:'CodexAppServerRunner',cli:'deterministic app-server process',initialAndRefreshRegisteredBeforeDelivery:true,missingAuthorityRefused:true,wrongAccountRefused:true,registrationFailureRefused:true,timeoutRefused:true,providerInference:false}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
