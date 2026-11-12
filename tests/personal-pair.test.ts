import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import type {Control} from '../src/control.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Ledger} from '../src/ledger.ts';
import {createPairCode, redeemPairCode} from '../src/personal-pair.ts';
import {createProjectGateway} from '../src/projects-api.ts';

const alphabet=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

async function directory(){return realpath(await mkdtemp(join(tmpdir(),'ac-pair-')));}

test('a pair code works once, expires, and then wrong attempts are limited',async()=>{
 const root=await directory();
 try{
  const issued=await createPairCode(root,1_000_000);
  assert.match(issued.code,alphabet);
  assert.equal(issued.code.includes('0')||issued.code.includes('O')||issued.code.includes('1')||issued.code.includes('I'),false);
  const file=await readFile(join(root,'pair-codes.json'),'utf8');
  assert.equal(file.includes(issued.code),false);
  assert.equal(file.includes(createHash('sha256').update(issued.code).digest('hex')),true);
  assert.equal((await stat(join(root,'pair-codes.json'))).mode&0o777,0o600);
  assert.equal(await redeemPairCode(root,issued.code.toLowerCase(),1_000_001),'accepted');
  assert.equal(await redeemPairCode(root,issued.code,1_000_002),'invalid');
  const expiring=await createPairCode(root,2_000_000);
  assert.equal(await redeemPairCode(root,expiring.code,2_000_000+10*60*1000),'invalid');
  const held=await createPairCode(root,3_000_000);
  for(let index=0;index<5;index++)assert.equal(await redeemPairCode(root,'ZZZZZZZZ',3_000_000+index),'invalid');
  const lockedAt=3_000_004;
  assert.equal(await redeemPairCode(root,held.code,lockedAt+10),'limited');
  assert.equal(await redeemPairCode(root,held.code,lockedAt+60_000-1),'limited');
  assert.equal(await redeemPairCode(root,held.code,lockedAt+60_000),'accepted');
  assert.equal(await redeemPairCode(root,held.code,lockedAt+60_000+1),'invalid');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the code route is public and does not ask for a session',async()=>{
 const root=await directory();
 try{
  const ledger={pool:{query:async()=>({rowCount:0,rows:[]})}} as unknown as Ledger;
  let authenticated=false;
  const app=createApi(ledger,{projectId:'00000000-0000-4000-8000-000000000001',nativeExecutionReady:false} as CezarRuntime,async()=>{authenticated=true;return 'owner';},()=>undefined,{
   configurationControl:{ledger} as Control,
   pairCodeLogin:async request=>{
    const body=await request.json() as {code?:string};
    const verdict=await redeemPairCode(root,String(body.code??''));
    if(verdict==='limited')return Response.json({error:'PAIR_CODE_LIMIT'},{status:429});
    if(verdict!=='accepted')return Response.json({error:'PAIR_CODE_INVALID'},{status:401});
    return Response.json({state:'authenticated'});
   },
  });
  const issued=await createPairCode(root);
  const headers={'content-type':'application/json',origin:'http://127.0.0.1:18402'};
  const ok=await app.request('/api/v1/ac/auth/code',{method:'POST',headers,body:JSON.stringify({code:issued.code})});
  assert.equal(ok.status,200);
  assert.equal(authenticated,false);
  assert.equal((await ok.json() as {state:string}).state,'authenticated');
  assert.equal((await app.request('/api/v1/ac/auth/code',{method:'POST',headers,body:JSON.stringify({code:issued.code})})).status,401);
  const gateway=createProjectGateway({
   projects:undefined as never,runtimes:undefined as never,defaultProjectId:'00000000-0000-4000-8000-000000000001',
   authenticate:async()=>{authenticated=true;return null;},
   publicFetch:async request=>app.fetch(request),
   appFor:()=>{throw new Error('APP');},
  });
  const missed=await gateway(new Request('http://127.0.0.1:18402/api/v1/ac/auth/code',{method:'POST',headers,body:JSON.stringify({code:'ZZZZZZZZ'})}));
  assert.equal(missed.status,401);
  assert.equal(authenticated,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
