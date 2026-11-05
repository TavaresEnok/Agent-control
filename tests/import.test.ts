import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import nacl from 'tweetnacl';
import {z} from 'zod';
import {Ledger} from '../src/ledger.ts';
import {loadHappier} from '../src/happier.ts';
import {IsolatedImport,type ImportTransport} from '../src/import.ts';
import {HappierImportTransport} from '../src/happier-import.ts';
import {keyFingerprint} from '../src/context-keys.ts';

test('encrypted import survives lost acknowledgement, preserves order and pauses the imported context',{timeout:60000},async()=>{
 const database=process.env.AC_TEST_DATABASE_URL;if(!database?.includes('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(database);await db.migrate();const boundary=await loadHappier(),key=randomBytes(32),challenge=randomBytes(32),kp=nacl.sign.keyPair.fromSeed(key);
 const base=(process.env.AC_TEST_HAPPIER_URL ?? 'http://127.0.0.1:18401'),b64=(x:Uint8Array)=>Buffer.from(x).toString('base64');
 const response=await fetch(base+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(kp.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,kp.secretKey))})});
 assert.equal(response.status,200);const {token}=z.object({token:z.string()}).passthrough().parse(await response.json());
 const api=async(path:string,payload?:unknown)=>{const result=await fetch(base+path,{method:payload?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined});assert(result.ok,`fixture HTTP ${result.status}`);return result.json() as Promise<unknown>;};
 const principal=z.object({id:z.string()}).passthrough().parse(await api('/v1/account/profile')).id,project=randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Import fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const seal=(value:unknown)=>boundary.encodeBase64(boundary.encrypt(key,'legacy',value));
  const machineId=randomUUID();await api('/v1/machines',{id:machineId,metadata:seal({host:'fixture',platform:'linux',happyCliVersion:'0.2.18',homeDir:'/tmp/fixture'}),daemonState:seal({status:'running',startedAt:Date.now()})});
  const session=z.object({session:z.object({id:z.string()}).passthrough()}).passthrough().parse(await api('/v1/sessions',{
   tag:'ac-import-'+randomUUID(),encryptionMode:'e2ee',metadata:seal({machineId,path:'/tmp/fixture',host:'fixture',homeDir:'/tmp/fixture',version:'0.2.18',name:'Import',flavor:'claude',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})).session.id;
  const target=new HappierImportTransport(base,async user=>{assert.equal(user,principal);return token;},
   async(user,id,variant,fingerprint)=>user===principal&&id===session&&variant==='legacy'&&fingerprint===keyFingerprint(key),
   async(user,id,ciphertext)=>user===principal&&id===session&&boundary.decrypt(key,'legacy',boundary.decodeBase64(ciphertext))!==null);
  let failOnce=true;
  const transport:ImportTransport={verifySession:(...args)=>target.verifySession(...args),verifySessionKey:(...args)=>target.verifySessionKey(...args),
   verifyCiphertext:(...args)=>target.verifyCiphertext(...args),deliver:async(...args)=>{await target.deliver(...args);if(failOnce){failOnce=false;throw Error('INJECTED_ACK_LOSS');}}};
  const importer=new IsolatedImport(db,transport),importId=randomUUID(),messages=['Primeira solicitação sintética','Segunda solicitação sintética'];
  const bundle={schemaVersion:1 as const,importId,projectId:project,sourceNamespace:'fixture-'+randomUUID(),contexts:[{id:'chat-1',sessionId:session,sourcePaused:false,
   keyVariant:'legacy' as const,keyFingerprint:keyFingerprint(key),messages:messages.map((text,i)=>({id:'msg-'+i,ciphertext:seal({role:'user',content:{type:'text',text}})})),
   runs:[{id:'run-1',state:'completed' as const,artifactRef:'git:synthetic'}]}]};
  await importer.stage(principal,bundle);await assert.rejects(importer.deliver(principal,importId),/INJECTED_ACK_LOSS/);
  assert.equal((await importer.deliver(principal,importId)).state,'completed');assert.equal((await importer.stage(principal,bundle)).state,'completed');
  const history=z.object({messages:z.array(z.object({content:z.unknown()}).passthrough())}).passthrough().parse(await api(`/v1/sessions/${session}/messages?scope=main&limit=150`));
  const texts=history.messages.map(m=>{const e=z.object({t:z.literal('encrypted'),c:z.string()}).parse(m.content);return z.object({role:z.literal('user'),content:z.object({text:z.string()}).passthrough()}).passthrough().parse(boundary.decrypt(key,'legacy',boundary.decodeBase64(e.c))).content.text;}).reverse();
  assert.deepEqual(texts,messages);
  assert.equal((await db.pool.query('SELECT count(*) n FROM ac_import_messages WHERE entry_id IN (SELECT id FROM ac_import_entries WHERE batch_id=$1)',[importId])).rows[0].n,'0');
  const entry=(await db.pool.query('SELECT * FROM ac_import_entries WHERE batch_id=$1',[importId])).rows[0];
  assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[entry.context_id])).rows[0].paused,true);
  assert.equal((await db.pool.query('SELECT state FROM ac_imported_runs WHERE entry_id=$1',[entry.id])).rows[0].state,'completed');
  await importer.archive(principal,importId);
  assert.equal((await db.pool.query('SELECT archived FROM ac_contexts WHERE id=$1',[entry.context_id])).rows[0].archived,true);
 }finally{await db.close();}
});
