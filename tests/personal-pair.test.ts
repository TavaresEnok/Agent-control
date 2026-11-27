import {describe, test} from 'node:test';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import type {Control} from '../src/control.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Ledger} from '../src/ledger.ts';
import {configuredTrustedProxies, createPairCode, pairClientIp, redeemPairCode, trustedProxyList} from '../src/personal-pair.ts';
import {createProjectGateway} from '../src/projects-api.ts';

const alphabet=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

async function directory(){return realpath(await mkdtemp(join(tmpdir(),'ac-pair-')));}

describe('pair codes', {concurrency: false}, () => {
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
  assert.equal(await redeemPairCode(root,held.code,lockedAt+10,'unknown'),'limited');
  assert.equal(await redeemPairCode(root,held.code,lockedAt+60_000-1),'limited');
  assert.equal(await redeemPairCode(root,held.code,lockedAt+60_000),'accepted');
  assert.equal(await redeemPairCode(root,held.code,lockedAt+60_000+1),'invalid');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('one blocked address does not block another, and a hundred errors close the window',async()=>{
 const root=await directory();
 try{
  // Default policy: only the connection address counts; a forwarded header from anyone is ignored.
  assert.equal(pairClientIp('203.0.113.5, 10.0.0.8', '192.0.2.1'), '192.0.2.1');
  assert.equal(pairClientIp('not-an-ip, 203.0.113.5', '192.0.2.1'), '192.0.2.1');
  assert.equal(pairClientIp('203.0.113.5', null), 'unknown');
  assert.equal(pairClientIp(null, null), 'unknown');
  const held=await createPairCode(root, 5_000_000);
  for(let index=0;index<5;index++)assert.equal(await redeemPairCode(root,'ZZZZZZZZ',5_000_000+index,'203.0.113.5'),'invalid');
  assert.equal(await redeemPairCode(root,held.code,5_000_010,'203.0.113.5'),'limited');
  assert.equal(await redeemPairCode(root,held.code,5_000_011,'203.0.113.9'),'accepted');
  const crowd=await createPairCode(root, 8_000_000);
  for(let index=0;index<100;index++)assert.equal(await redeemPairCode(root,'ZZZZZZZZ',8_000_000,`198.51.100.${index+1}`),'invalid');
  assert.equal(await redeemPairCode(root,crowd.code,8_000_010,'203.0.113.20'),'limited');
  assert.equal(await redeemPairCode(root,crowd.code,8_000_000+60_000,'203.0.113.20'),'accepted');
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
});

test('the forwarded header is believed only when it comes from a listed proxy',()=>{
 const caddy=trustedProxyList('127.0.0.1,::1');
 // Direct: the connection address is the client, whatever the header says.
 assert.equal(pairClientIp('198.51.100.9','203.0.113.5',caddy),'203.0.113.5');
 assert.equal(pairClientIp('198.51.100.9','::ffff:203.0.113.5',caddy),'203.0.113.5');
 // Behind the local Caddy: the address Caddy wrote is the client.
 assert.equal(pairClientIp('203.0.113.5','127.0.0.1',caddy),'203.0.113.5');
 assert.equal(pairClientIp('203.0.113.5','::ffff:127.0.0.1',caddy),'203.0.113.5');
 assert.equal(pairClientIp('2001:db8::7','::1',caddy),'2001:db8::7');
 // A client that writes its own header cannot pick its address: only the rightmost untrusted hop counts.
 assert.equal(pairClientIp('198.51.100.9, 203.0.113.5','127.0.0.1',caddy),'203.0.113.5');
 assert.equal(pairClientIp('198.51.100.9, 203.0.113.5, 127.0.0.1','127.0.0.1',caddy),'203.0.113.5');
 // Missing or broken header behind a proxy falls back to the proxy address.
 assert.equal(pairClientIp(null,'127.0.0.1',caddy),'127.0.0.1');
 assert.equal(pairClientIp('garbage','127.0.0.1',caddy),'127.0.0.1');
 // CIDR entries, and entries that are not addresses trust nothing.
 const range=trustedProxyList(['10.0.0.0/8','nonsense','10.0.0.0/99']);
 assert.equal(pairClientIp('203.0.113.5','10.1.2.3',range),'203.0.113.5');
 assert.equal(pairClientIp('203.0.113.5','11.1.2.3',range),'11.1.2.3');
 assert.equal(pairClientIp('203.0.113.5','127.0.0.1',trustedProxyList('nonsense')),'127.0.0.1');
 // The installation sets the list through the environment; without it nothing is trusted.
 assert.equal(pairClientIp('203.0.113.5','127.0.0.1',configuredTrustedProxies({})),'127.0.0.1');
 assert.equal(pairClientIp('203.0.113.5','127.0.0.1',configuredTrustedProxies({AC_TRUSTED_PROXIES:'127.0.0.1, ::1'})),'203.0.113.5');
});

test('a spoofed forwarded header cannot dodge the per-address limit',async()=>{
 const root=await directory();
 try{
  const held=await createPairCode(root,9_000_000);
  for(let index=0;index<5;index++){
   const address=pairClientIp(`198.51.100.${index+1}`,'203.0.113.5');
   assert.equal(await redeemPairCode(root,'ZZZZZZZZ',9_000_000+index,address),'invalid');
  }
  assert.equal(await redeemPairCode(root,held.code,9_000_010,pairClientIp('198.51.100.77','203.0.113.5')),'limited');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('issuance in another process and gateway redemption share the same lock',async t=>{
 const {spawn}=await import('node:child_process');
 const root=await directory();
 t.after(()=>rm(root,{recursive:true,force:true}));
 const issued=await createPairCode(root);
 const lock=spawn('/usr/bin/flock',[join(root,'pair-codes.json.lock'),'/bin/sh','-c','echo locked; read release'],{stdio:['pipe','pipe','inherit']});
 const lockClosed=once(lock,'close');
 await once(lock.stdout,'data');
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
  "import {createPairCode} from './src/personal-pair.ts'; console.log('ready'); console.log((await createPairCode(process.argv[1])).code);",root],
  {stdio:['ignore','pipe','inherit']});
 const childClosed=once(child,'close');
 let output='';
 child.stdout.on('data',chunk=>{output+=String(chunk);});
 let redeemed=false;
 const redeem=redeemPairCode(root,issued.code).then(result=>{redeemed=true;return result;});
 try{
  await once(child.stdout,'data');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(redeemed,false);
  assert.equal(output.trim(),'ready');
 }finally{
  lock.stdin.end('release\n');
  await Promise.all([lockClosed,childClosed,redeem]);
 }
 assert.equal((await childClosed)[0],0);
 assert.equal(await redeem,'accepted');
 assert.equal(await redeemPairCode(root,issued.code),'invalid');
 assert.equal(await redeemPairCode(root,output.trim().split('\n')[1]??''),'accepted');
});
