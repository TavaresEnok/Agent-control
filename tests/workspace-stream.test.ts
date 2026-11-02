import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {managedWorkspaceStream} from '../src/workspace-stream.ts';
import {RunStore} from '../upstream/cezar/packages/cezar/dist/runs/store.js';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('managed stream uses native frames but only PG-admitted runs of selected project and closes after revocation',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'stream'),db=new Ledger(database.url),root=await mkdtemp(join(tmpdir(),'ac-stream-'));
 const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  await db.migrate();const projectA=randomUUID(),projectB=randomUUID(),principal='stream-'+randomUUID();
  const intents=[];
  for(const project of [projectA,projectB]){
   await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Private project']);
   await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
   const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager');
   intents.push(await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,
    policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:stream'}},authority,'api'));
  }
  const store=RunStore.open(root),runtime={projectId:projectA,store};
  const response=await managedWorkspaceStream(db,runtime,principal,new Request('http://localhost/api/v1/p/'+projectA+'/workspace/events',{signal:abort.signal}),async()=>principal,{flushMs:10,heartbeatMs:50});
  assert.equal(response.headers.get('content-type'),'text/event-stream');reader=response.body!.getReader();
  const decode=new TextDecoder();assert.match(decode.decode((await reader.read()).value),/event: ping/);
  store.emit('run',{id:intents[0].run_id,status:'running',task:'Admitted A'});
  store.emit('run',{id:intents[1].run_id,status:'running',task:'Forbidden B'});
  const unadmitted=randomUUID();store.emit('run',{id:unadmitted,status:'running',task:'Unadmitted native run'});
  let observed='';
  for(let i=0;i<8&&!observed.includes(intents[0].run_id);i++){
   const item=await Promise.race([reader.read(),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('STREAM_TIMEOUT')),2000))]);
   observed+=decode.decode(item.value);
  }
  assert(observed.includes(intents[0].run_id));assert(!observed.includes(intents[1].run_id));assert(!observed.includes(unadmitted));
  assert(!observed.includes('Admitted A'),'native slim frames must omit task text');
  assert(observed.includes('"project":"'+projectA+'"'));
  await db.pool.query('DELETE FROM ac_memberships WHERE project_id=$1 AND principal_id=$2',[projectA,principal]);
  store.emit('run',{id:intents[0].run_id,status:'done',task:'After revoked membership'});
  let closed=false;
  for(let i=0;i<5&&!closed;i++){
   const item=await reader.read();closed=item.done;assert(!decode.decode(item.value).includes('After revoked membership'));
  }
  assert(closed);assert.equal(store.listenerCount('run'),0);
  await assert.rejects(managedWorkspaceStream(db,runtime,principal,new Request('http://localhost/'),async()=>principal),/PROJECT_FORBIDDEN/);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[projectA,principal]);
  let authenticated=true;
  const second=await managedWorkspaceStream(db,runtime,principal,new Request('http://localhost/'),async()=>authenticated?principal:null,{flushMs:10,heartbeatMs:50});
  reader=second.body!.getReader();await reader.read();authenticated=false;
  store.emit('run',{id:intents[0].run_id,status:'done',task:'Revoked session'});
  assert.equal((await reader.read()).done,true);assert.equal(store.listenerCount('run'),0);
  const third=await managedWorkspaceStream(db,runtime,principal,new Request('http://localhost/'),async()=>principal,{flushMs:10,heartbeatMs:50});
  reader=third.body!.getReader();await reader.read();store.emit('managed-runtime-close');
  assert.equal((await reader.read()).done,true);assert.equal(store.listenerCount('run'),0);
  assert.equal(store.listenerCount('managed-runtime-close'),0);
 }finally{abort.abort();await reader?.cancel();await db.close();await database.close();await rm(root,{recursive:true,force:true});}
});
