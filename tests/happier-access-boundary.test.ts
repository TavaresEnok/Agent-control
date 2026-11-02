import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HappierEndpoint} from '../src/happier.ts';
import {Refusal} from '../src/contracts.ts';

test('session transport requires current project permission and manager epoch, even with an authorized content key',async()=>{
 const endpoint=Object.create(HappierEndpoint.prototype) as HappierEndpoint;
 let revoked=false,stale=false,wrongProject=false,linked=true,checks=0;
 Object.defineProperties(endpoint,{
  runtime:{value:{projectId:'project'}},options:{value:{principal:'owner',sessionId:'session',authority:{contextId:'context'}}},
  ledger:{value:{async authorize(){checks++;if(revoked)throw new Refusal('CONTEXT_FORBIDDEN',403);return {project_id:wrongProject?'other':'project'};},
   async fence(){if(stale)throw new Refusal('STALE_MANAGER');},
   async tx(fn:(db:unknown)=>Promise<unknown>){return fn({async query(){return {rows:[{session_id:linked?'session':'other',principal_id:'owner'}]};}});}}},
 });
 endpoint.validateKey=async()=>{};
 await endpoint.validateLink();assert.equal(checks,1);
 revoked=true;await assert.rejects(endpoint.validateLink(),/CONTEXT_FORBIDDEN/);revoked=false;
 stale=true;await assert.rejects(endpoint.validateLink(),/STALE_MANAGER/);stale=false;
 wrongProject=true;await assert.rejects(endpoint.validateLink(),/PROJECT_RUNTIME_MISMATCH/);wrongProject=false;
 linked=false;await assert.rejects(endpoint.validateLink(),/SESSION_CONTEXT_MISMATCH/);
});
