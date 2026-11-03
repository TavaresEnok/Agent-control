import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {digest,Refusal} from '../src/contracts.ts';
import {keyFingerprint} from '../src/context-keys.ts';
import {beginKeyRotation,createKeyRotationPlan,stepKeyRotation,KEY_ROTATION_MAX_ENTRIES,type KeyRotationCheckpoint,type KeyRotationExecutor,type KeyRotationPlan} from '../src/key-rotation-plan.ts';

type Entry={id:string;keyVersion:number;state:'sealed'|'uncertain'|'corrupted'};
type Effect='observe'|'reenvelope'|'verify'|'promote'|'retire';
type Recorded={id:string;keyVersion:number;candidateDigest:string;result?:'verified'|'uncertain'|'corrupted'};
const forbidden=new Set(['key','plaintext','masterKey','secret','ciphertext','privateKey','currentKey','nextKey','candidateDigest']);

function assertNoKeyMaterial(value:unknown,secrets:readonly Uint8Array[],extra:readonly string[]=[]){
 const text=JSON.stringify(value);
 const walk=(node:unknown)=>{
  if(Array.isArray(node)){for(const item of node)walk(item);return;}
  if(node!==null&&typeof node==='object'){
   for(const [key,child] of Object.entries(node)){assert.equal(forbidden.has(key),false,key);walk(child);}
  }
 };
 walk(value);
 for(const secret of secrets){
  assert.equal(text.includes(Buffer.from(secret).toString('hex')),false);
  assert.equal(text.includes(Buffer.from(secret).toString('base64')),false);
  assert.equal(text.includes(Buffer.from(secret).toString('base64url')),false);
 }
 for(const leaked of extra)assert.equal(text.includes(leaked),false);
}

function custody(options:{entries:readonly Entry[];current:Uint8Array;next:Uint8Array;fail?:{effect:Effect;on:number;when:'before'|'after'}|null;verifyResult?:(entry:{id:string;keyVersion:number})=>'verified'|'uncertain'|'corrupted';observe?:string;candidateFor?:(entry:{id:string;keyVersion:number})=>string}){
 const oldFp=keyFingerprint(options.current),newFp=keyFingerprint(options.next);
 const installed=new Set([oldFp,newFp]);
 const records=new Map<string,Recorded>();
 const calls:Record<Effect,number>={observe:0,reenvelope:0,verify:0,promote:0,retire:0};
 const log:Effect[]=[];
 const control:{fail:{effect:Effect;on:number;when:'before'|'after'}|null}={fail:options.fail??null};
 let active=oldFp,promoted=false,verifiedCount=0;
 const sealedCount=options.entries.filter(entry=>entry.state==='sealed').length;
 const idOf=(entry:{id:string;keyVersion:number})=>`${entry.id}/${entry.keyVersion}`;
 const begin=(effect:Effect)=>{
  calls[effect]++;log.push(effect);
  if(control.fail?.effect===effect&&calls[effect]===control.fail.on&&control.fail.when==='before')throw new Error('INTERRUPTED');
 };
 const end=(effect:Effect)=>{
  if(control.fail?.effect===effect&&calls[effect]===control.fail.on&&control.fail.when==='after')throw new Error('INTERRUPTED');
 };
 const executor:KeyRotationExecutor={
  observe(){
   begin('observe');
   const rows=[...records.values()];
   const body={
    activeKeyFingerprint:options.observe??active,oldKeyInstalled:installed.has(oldFp),
    candidates:rows.map(row=>({id:row.id,keyVersion:row.keyVersion,candidateDigest:row.candidateDigest})),
    verifications:rows.filter(row=>row.result).map(row=>({id:row.id,keyVersion:row.keyVersion,result:row.result!})),
   };
   end('observe');
   return body;
  },
  reenvelope(entry){
   begin('reenvelope');
   const key=idOf(entry);
   if(!records.has(key))records.set(key,{id:entry.id,keyVersion:entry.keyVersion,candidateDigest:options.candidateFor?.(entry)??digest({entry:key,wrap:newFp})});
   end('reenvelope');
   return {candidateDigest:records.get(key)!.candidateDigest};
  },
  verify(entry){
   begin('verify');
   const row=records.get(idOf(entry));
   if(!row){end('verify');return 'corrupted';}
   if(!row.result){
    row.result=options.verifyResult?.(entry)??'verified';
    if(row.result==='verified')verifiedCount++;
   }
   end('verify');
   return row.result;
  },
  promote(request){
   begin('promote');
   if(verifiedCount!==sealedCount||request.oldKeyFingerprint!==oldFp||request.newKeyFingerprint!==newFp)throw new Error('PROMOTE_TOO_EARLY');
   active=newFp;promoted=true;
   end('promote');
  },
  retire(request){
   begin('retire');
   if(!promoted||verifiedCount!==sealedCount||request.oldKeyFingerprint!==oldFp)throw new Error('RETIRE_TOO_EARLY');
   installed.delete(oldFp);
   end('retire');
  },
 };
 return {
  executor,oldFp,newFp,installed,records,calls,log,control,active:()=>active,
  seedComplete(plan:KeyRotationPlan){
   for(const entry of plan.entries){
    if(entry.state!=='sealed')continue;
    records.set(idOf(entry),{id:entry.id,keyVersion:entry.keyVersion,candidateDigest:digest({entry:idOf(entry),wrap:newFp}),result:'verified'});
    verifiedCount++;
   }
   active=newFp;promoted=true;installed.delete(oldFp);
  },
 };
}

const sealed:Entry[]=[
 {id:'b-entry',keyVersion:2,state:'sealed'},
 {id:'a-entry',keyVersion:3,state:'sealed'},
 {id:'a-entry',keyVersion:1,state:'sealed'},
];

function planFor(entries:readonly Entry[],current:Uint8Array,next:Uint8Array,batchSize=2){
 return createKeyRotationPlan({entries:[...entries],currentKey:current,nextKey:next,batchSize});
}
function run(plan:KeyRotationPlan,executor:KeyRotationExecutor){
 const seen:KeyRotationCheckpoint[]=[];
 let checkpoint=beginKeyRotation(plan);
 for(let step=0;step<100;step++){
  const before=structuredClone(checkpoint);
  const next=stepKeyRotation(plan,checkpoint,executor);
  assert.deepEqual(checkpoint,before);
  seen.push(next);
  if(next.phase==='complete'||next.phase==='blocked')return {checkpoint:next,seen};
  assert.notDeepEqual(next,checkpoint);
  checkpoint=next;
 }
 throw new Error('ROTATION_DID_NOT_FINISH');
}
function runFrom(plan:KeyRotationPlan,start:KeyRotationCheckpoint,store:ReturnType<typeof custody>){
 let checkpoint=start;
 for(let step=0;step<100&&checkpoint.phase!=='complete'&&checkpoint.phase!=='blocked';step++)checkpoint=stepKeyRotation(plan,checkpoint,store.executor);
 return checkpoint;
}
function interruptAt(plan:KeyRotationPlan,store:ReturnType<typeof custody>){
 let checkpoint=beginKeyRotation(plan);
 for(let step=0;step<30;step++){
  const saved=structuredClone(checkpoint);
  try{checkpoint=stepKeyRotation(plan,checkpoint,store.executor);}
  catch(error){
   assert.equal(error instanceof Error&&error.message,'INTERRUPTED');
   assert.deepEqual(checkpoint,saved);
   return saved;
  }
 }
 throw new Error('INTERRUPTION_DID_NOT_HAPPEN');
}

test('rotation plan is deterministic and stores commitments instead of executor digests',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const forward=planFor(sealed,current,next);
 const reverse=planFor([...sealed].reverse(),Buffer.from(current),Buffer.from(next));
 assert.deepEqual(forward,reverse);
 assert.equal(digest(forward),digest(reverse));
 assert.deepEqual(forward.entries.map(entry=>`${entry.id}:${entry.keyVersion}`),['a-entry:1','a-entry:3','b-entry:2']);
 assert.deepEqual(forward.phases,['prepare','reenvelope','verify','promote','retire']);
 assert.equal(forward.oldKeyFingerprint,keyFingerprint(current));
 assert.equal(forward.newKeyFingerprint,keyFingerprint(next));
 assert.equal(forward.materialSeals.length,6);
 assertNoKeyMaterial(forward,[current,next]);
 const first=custody({entries:sealed,current,next});
 const second=custody({entries:sealed,current,next});
 const left=run(forward,first.executor),right=run(reverse,second.executor);
 assert.deepEqual(left.seen,right.seen);
 const raw=[...first.records.values()].map(row=>row.candidateDigest);
 assert.equal(raw.length,3);
 assertNoKeyMaterial(left.seen,[current,next],raw);
 for(const candidate of left.checkpoint.candidates)assert.equal(raw.includes(candidate.commitment),false);
 assert.equal(left.checkpoint.planDigest,digest(forward));
 assert.equal(JSON.stringify(forward).includes(forward.oldKeyFingerprint),true);
 assert.equal(JSON.stringify(left.checkpoint).includes(Buffer.from(current).toString('hex')),false);
});

test('identical, empty, duplicate and oversized inventories are refused before effects',()=>{
 const current=randomBytes(32),next=randomBytes(32),store=custody({entries:sealed,current,next});
 assert.throws(()=>planFor(sealed,current,current),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_UNCHANGED');
 assert.throws(()=>planFor(sealed,current,Buffer.from(current)),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_UNCHANGED');
 assert.throws(()=>createKeyRotationPlan({entries:sealed,currentKey:randomBytes(31),nextKey:next}),error=>error instanceof Refusal&&error.code==='INVALID_CONTEXT_KEY');
 assert.throws(()=>createKeyRotationPlan({entries:[],currentKey:current,nextKey:next}),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_EMPTY');
 assert.throws(()=>planFor([sealed[0]!,sealed[0]!],current,next),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_DUPLICATE_ENTRY');
 assert.throws(()=>createKeyRotationPlan({entries:Array.from({length:KEY_ROTATION_MAX_ENTRIES+1},(_,index)=>({id:`e${index}`,keyVersion:1,state:'sealed'})),currentKey:current,nextKey:next}),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_LIMIT');
 for(const encoding of [Buffer.from(current).toString('hex'),Buffer.from(current).toString('base64'),Buffer.from(next).toString('base64url')]){
  assert.throws(()=>createKeyRotationPlan({entries:[{id:encoding,keyVersion:1,state:'sealed'}],currentKey:current,nextKey:next}),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_MATERIAL_REJECTED');
 }
 assert.equal(store.calls.observe+store.calls.reenvelope+store.calls.verify+store.calls.promote+store.calls.retire,0);
 assert.equal(store.installed.has(store.oldFp),true);
});

test('happy path re-envelopes in stable batches and retires the old key only after full verification',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const store=custody({entries:sealed,current,next});
 let checkpoint=beginKeyRotation(plan);
 const phases:string[]=[];
 while(checkpoint.phase!=='complete'){
  assert.equal(store.installed.has(store.oldFp),true);
  checkpoint=stepKeyRotation(plan,checkpoint,store.executor);
  phases.push(checkpoint.phase);
  assertNoKeyMaterial(checkpoint,[current,next],[...store.records.values()].map(row=>row.candidateDigest));
 }
 assert.deepEqual(phases,['reenvelope','reenvelope','verify','verify','promote','retire','complete']);
 assert.deepEqual(store.log,[
  'observe','observe','reenvelope','reenvelope','observe','reenvelope','observe','verify','verify','observe','verify','observe','promote','observe','retire',
 ]);
 assert.deepEqual(checkpoint.candidates.map(entry=>entry.id+':'+entry.keyVersion),['a-entry:1','a-entry:3','b-entry:2']);
 assert.equal(checkpoint.promoted,true);
 assert.equal(checkpoint.retired,true);
 assert.equal(store.active(),store.newFp);
 assert.equal(store.installed.has(store.oldFp),false);
 assert.equal(store.installed.has(store.newFp),true);
 assert.equal(store.records.size,3);
 const stable=stepKeyRotation(plan,checkpoint,store.executor);
 assert.deepEqual(stable,checkpoint);
 assert.equal(store.calls.retire,1);
 assert.equal(store.calls.promote,1);
 assert.equal(store.calls.observe,7);
});

test('an interruption before the effect resumes that effect and still retires once',()=>{
 const cases:Array<{effect:Effect;reenvelopes:number;verifies:number;promotes:number;retires:number}> =[
  {effect:'observe',reenvelopes:3,verifies:3,promotes:1,retires:1},
  {effect:'reenvelope',reenvelopes:4,verifies:3,promotes:1,retires:1},
  {effect:'verify',reenvelopes:3,verifies:4,promotes:1,retires:1},
  {effect:'promote',reenvelopes:3,verifies:3,promotes:2,retires:1},
  {effect:'retire',reenvelopes:3,verifies:3,promotes:1,retires:2},
 ];
 for(const expected of cases){
  const current=randomBytes(32),next=randomBytes(32);
  const plan=planFor(sealed,current,next);
  const store=custody({entries:sealed,current,next,fail:{effect:expected.effect,on:1,when:'before'}});
  const saved=interruptAt(plan,store);
  assert.equal(store.installed.has(store.oldFp),true);
  store.control.fail=null;
  const finished=runFrom(plan,saved,store);
  assert.equal(finished.phase,'complete');
  assert.equal(store.calls.reenvelope,expected.reenvelopes);
  assert.equal(store.calls.verify,expected.verifies);
  assert.equal(store.calls.promote,expected.promotes);
  assert.equal(store.calls.retire,expected.retires);
  assert.equal(store.installed.has(store.oldFp),false);
  assertNoKeyMaterial(finished,[current,next],[...store.records.values()].map(row=>row.candidateDigest));
 }
});

test('an effect that lands and then throws is not repeated when the checkpoint was not saved',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const reenvelopeStore=custody({entries:sealed,current,next,fail:{effect:'reenvelope',on:2,when:'after'}});
 const reenvelopeSaved=interruptAt(plan,reenvelopeStore);
 assert.equal(reenvelopeStore.records.size,2);
 assert.equal(reenvelopeStore.calls.reenvelope,2);
 assert.equal(reenvelopeSaved.candidates.length,0);
 reenvelopeStore.control.fail=null;
 const reenvelopeDone=runFrom(plan,reenvelopeSaved,reenvelopeStore);
 assert.equal(reenvelopeDone.phase,'complete');
 assert.equal(reenvelopeStore.calls.reenvelope,3);
 assert.equal(reenvelopeStore.calls.promote,1);
 assert.equal(reenvelopeStore.calls.retire,1);

 const verifyStore=custody({entries:sealed,current,next,fail:{effect:'verify',on:1,when:'after'}});
 const verifySaved=interruptAt(plan,verifyStore);
 assert.equal([...verifyStore.records.values()].filter(row=>row.result==='verified').length,1);
 assert.equal(verifySaved.verifications.length,0);
 verifyStore.control.fail=null;
 const verifyDone=runFrom(plan,verifySaved,verifyStore);
 assert.equal(verifyDone.phase,'complete');
 assert.equal(verifyStore.calls.verify,3);
 assert.equal(verifyStore.calls.retire,1);

 const promoteStore=custody({entries:sealed,current,next,fail:{effect:'promote',on:1,when:'after'}});
 const promoteSaved=interruptAt(plan,promoteStore);
 assert.equal(promoteStore.active(),promoteStore.newFp);
 assert.equal(promoteStore.installed.has(promoteStore.oldFp),true);
 assert.equal(promoteSaved.phase,'promote');
 assert.equal(promoteStore.calls.promote,1);
 promoteStore.control.fail=null;
 const promoteAdopted=stepKeyRotation(plan,promoteSaved,promoteStore.executor);
 assert.equal(promoteAdopted.phase,'retire');
 assert.equal(promoteAdopted.promoted,true);
 assert.equal(promoteStore.calls.promote,1);
 const promoteDone=runFrom(plan,promoteAdopted,promoteStore);
 assert.equal(promoteDone.phase,'complete');
 assert.equal(promoteStore.calls.retire,1);

 const retireStore=custody({entries:sealed,current,next,fail:{effect:'retire',on:1,when:'after'}});
 const retireSaved=interruptAt(plan,retireStore);
 assert.equal(retireStore.installed.has(retireStore.oldFp),false);
 assert.equal(retireSaved.retired,false);
 assert.equal(retireStore.calls.retire,1);
 retireStore.control.fail=null;
 const retireDone=stepKeyRotation(plan,retireSaved,retireStore.executor);
 assert.equal(retireDone.phase,'complete');
 assert.equal(retireDone.retired,true);
 assert.equal(retireStore.calls.retire,1);
 assertNoKeyMaterial([reenvelopeDone,verifyDone,promoteDone,retireDone],[current,next]);
});

test('discarding a successful checkpoint does not replay the batch, promotion or retirement',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const store=custody({entries:sealed,current,next});
 let checkpoint=beginKeyRotation(plan);
 checkpoint=stepKeyRotation(plan,checkpoint,store.executor);
 const behindBatch=structuredClone(checkpoint);
 const producedBatch=stepKeyRotation(plan,checkpoint,store.executor);
 assert.equal(producedBatch.candidates.length,2);
 assert.equal(store.calls.reenvelope,2);
 const adoptedBatch=stepKeyRotation(plan,behindBatch,store.executor);
 assert.deepEqual(adoptedBatch,producedBatch);
 assert.equal(store.calls.reenvelope,2);
 checkpoint=adoptedBatch;
 while(checkpoint.phase!=='promote')checkpoint=stepKeyRotation(plan,checkpoint,store.executor);
 const behindPromote=structuredClone(checkpoint);
 const producedPromote=stepKeyRotation(plan,checkpoint,store.executor);
 assert.equal(producedPromote.phase,'retire');
 assert.equal(store.calls.promote,1);
 const adoptedPromote=stepKeyRotation(plan,behindPromote,store.executor);
 assert.deepEqual(adoptedPromote,producedPromote);
 assert.equal(store.calls.promote,1);
 assert.equal(store.installed.has(store.oldFp),true);
 const behindRetire=structuredClone(adoptedPromote);
 const producedRetire=stepKeyRotation(plan,adoptedPromote,store.executor);
 assert.equal(producedRetire.phase,'complete');
 assert.equal(store.calls.retire,1);
 const adoptedRetire=stepKeyRotation(plan,behindRetire,store.executor);
 assert.deepEqual(adoptedRetire,producedRetire);
 assert.equal(store.calls.retire,1);
 assert.equal(store.installed.has(store.oldFp),false);
 assertNoKeyMaterial([producedBatch,producedPromote,producedRetire],[current,next],[...store.records.values()].map(row=>row.candidateDigest));
});

test('a fully durable rotation whose checkpoint is still at prepare completes in one read',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const store=custody({entries:sealed,current,next});
 store.seedComplete(plan);
 const done=stepKeyRotation(plan,beginKeyRotation(plan),store.executor);
 assert.equal(done.phase,'complete');
 assert.equal(done.promoted,true);
 assert.equal(done.retired,true);
 assert.equal(done.candidates.length,3);
 assert.equal(done.verifications.length,3);
 assert.equal(store.calls.observe,1);
 assert.equal(store.calls.reenvelope,0);
 assert.equal(store.calls.verify,0);
 assert.equal(store.calls.promote,0);
 assert.equal(store.calls.retire,0);
 const again=stepKeyRotation(plan,done,store.executor);
 assert.deepEqual(again,done);
 assert.equal(store.calls.observe,1);
 assertNoKeyMaterial(done,[current,next],[...store.records.values()].map(row=>row.candidateDigest));
});

test('a mid-batch interruption before the second entry retries only the missing entry',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const store=custody({entries:sealed,current,next,fail:{effect:'reenvelope',on:2,when:'before'}});
 const saved=interruptAt(plan,store);
 assert.equal(store.records.size,1);
 assert.equal(store.calls.reenvelope,2);
 assert.equal(saved.candidates.length,0);
 assert.equal(store.installed.has(store.oldFp),true);
 store.control.fail=null;
 const adopted=stepKeyRotation(plan,saved,store.executor);
 assert.equal(adopted.candidates.length,1);
 assert.equal(store.calls.reenvelope,2);
 const finished=runFrom(plan,adopted,store);
 assert.equal(finished.phase,'complete');
 assert.equal(store.records.size,3);
 assert.equal(store.calls.reenvelope,4);
 assert.equal(store.calls.retire,1);
});

test('uncertain or corrupted inventory blocks promotion and keeps the old key',()=>{
 for(const state of ['uncertain','corrupted'] as const){
  const current=randomBytes(32),next=randomBytes(32);
  const entries:Entry[]=[...sealed,{id:'z-bad',keyVersion:4,state}];
  const plan=planFor(entries,current,next);
  assert.deepEqual(plan.blockers,[{id:'z-bad',keyVersion:4,state}]);
  const store=custody({entries,current,next});
  const finished=run(plan,store.executor);
  assert.equal(finished.checkpoint.phase,'blocked');
  assert.equal(finished.checkpoint.blockedReason,'KEY_ROTATION_ENTRY_BLOCKED');
  assert.equal(store.calls.observe,1);
  assert.equal(store.calls.reenvelope,0);
  assert.equal(store.calls.verify,0);
  assert.equal(store.calls.promote,0);
  assert.equal(store.calls.retire,0);
  assert.equal(store.installed.has(store.oldFp),true);
  const repeated=stepKeyRotation(plan,finished.checkpoint,store.executor);
  assert.deepEqual(repeated,finished.checkpoint);
  assert.equal(store.calls.observe,1);
  assertNoKeyMaterial([plan,finished.checkpoint],[current,next]);
 }
});

test('corruption found during verification blocks promotion even after candidates exist',()=>{
 for(const result of ['corrupted','uncertain'] as const){
  const current=randomBytes(32),next=randomBytes(32);
  const plan=planFor(sealed,current,next);
  const store=custody({entries:sealed,current,next,verifyResult:entry=>entry.id==='b-entry'?result:'verified'});
  const finished=run(plan,store.executor);
  assert.equal(finished.checkpoint.phase,'blocked');
  assert.equal(finished.checkpoint.blockedReason,'KEY_ROTATION_VERIFICATION_FAILED');
  assert.equal(finished.checkpoint.verifications.at(-1)?.result,result);
  assert.equal(store.calls.promote,0);
  assert.equal(store.calls.retire,0);
  assert.equal(store.installed.has(store.oldFp),true);
  assert.equal(store.active(),store.oldFp);
  const verifiedCalls=store.calls.verify;
  const repeated=stepKeyRotation(plan,finished.checkpoint,store.executor);
  assert.deepEqual(repeated,finished.checkpoint);
  assert.equal(store.calls.verify,verifiedCalls);
  assert.equal(verifiedCalls,finished.checkpoint.verifications.length);
  assertNoKeyMaterial(finished.seen,[current,next],[...store.records.values()].map(row=>row.candidateDigest));
 }
});

test('a lost failing verification is adopted and not run again',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const store=custody({entries:sealed,current,next,verifyResult:()=>'corrupted',fail:{effect:'verify',on:1,when:'after'}});
 const saved=interruptAt(plan,store);
 assert.equal(saved.verifications.length,0);
 assert.equal(store.calls.verify,1);
 store.control.fail=null;
 const blocked=stepKeyRotation(plan,saved,store.executor);
 assert.equal(blocked.phase,'blocked');
 assert.equal(blocked.blockedReason,'KEY_ROTATION_VERIFICATION_FAILED');
 assert.equal(store.calls.verify,1);
 assert.equal(store.calls.promote,0);
 assert.equal(store.calls.retire,0);
 assert.equal(store.installed.has(store.oldFp),true);
});

test('a fingerprint mismatch or a retire checkpoint without full verification does not remove the old key',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const mismatched=custody({entries:sealed,current,next,observe:'ab'.repeat(32)});
 const blocked=run(plan,mismatched.executor);
 assert.equal(blocked.checkpoint.blockedReason,'KEY_ROTATION_SOURCE_MISMATCH');
 assert.equal(mismatched.calls.reenvelope,0);
 assert.equal(mismatched.calls.retire,0);
 assert.equal(mismatched.installed.has(mismatched.oldFp),true);

 const store=custody({entries:sealed,current,next});
 const illegal:KeyRotationCheckpoint={schemaVersion:1,planDigest:beginKeyRotation(plan).planDigest,phase:'retire',candidates:[],verifications:[],promoted:true,retired:false};
 assert.throws(()=>stepKeyRotation(plan,illegal,store.executor),error=>error instanceof Refusal&&(error.code==='KEY_ROTATION_RETIRE_FORBIDDEN'||error.code==='KEY_ROTATION_CHECKPOINT_CORRUPT'));
 const early:KeyRotationCheckpoint={...illegal,phase:'promote',promoted:false};
 assert.throws(()=>stepKeyRotation(plan,early,store.executor),error=>error instanceof Refusal&&(error.code==='KEY_ROTATION_PROMOTE_FORBIDDEN'||error.code==='KEY_ROTATION_CHECKPOINT_CORRUPT'));
 assert.equal(store.calls.promote,0);
 assert.equal(store.calls.retire,0);
 assert.equal(store.installed.has(store.oldFp),true);
 const drifted={...beginKeyRotation(plan),planDigest:'cd'.repeat(32)};
 assert.throws(()=>stepKeyRotation(plan,drifted,store.executor),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_CHECKPOINT_MISMATCH');
});

test('executor material and plaintext never enter the plan or the checkpoint',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const keyHex=Buffer.from(current).toString('hex');
 const keyBase64=Buffer.from(current).toString('base64');
 const plaintext='vault plaintext must stay out of the plan';
 const plaintextHex=Buffer.from('0123456789abcdef0123456789abcdef').toString('hex');
 const fingerprint=keyFingerprint(current);

 const leaked=custody({entries:sealed,current,next,candidateFor:()=>keyHex});
 let checkpoint=beginKeyRotation(plan);
 checkpoint=stepKeyRotation(plan,checkpoint,leaked.executor);
 const behind=structuredClone(checkpoint);
 const blocked=stepKeyRotation(plan,checkpoint,leaked.executor);
 assert.equal(blocked.phase,'blocked');
 assert.equal(blocked.blockedReason,'KEY_ROTATION_MATERIAL_REJECTED');
 assert.equal(blocked.candidates.length,0);
 assert.equal(leaked.calls.reenvelope,1);
 assert.equal(leaked.calls.promote,0);
 const adopted=stepKeyRotation(plan,behind,leaked.executor);
 assert.deepEqual(adopted,blocked);
 assert.equal(leaked.calls.reenvelope,1);
 assert.equal(leaked.installed.has(leaked.oldFp),true);
 assertNoKeyMaterial([plan,blocked,adopted],[current,next],[keyHex]);
 const repeated=stepKeyRotation(plan,blocked,leaked.executor);
 assert.deepEqual(repeated,blocked);
 assert.equal(leaked.calls.observe,3);

 const encoded=custody({entries:sealed,current,next,candidateFor:()=>keyBase64});
 let encodedCheckpoint=beginKeyRotation(plan);
 encodedCheckpoint=stepKeyRotation(plan,encodedCheckpoint,encoded.executor);
 assert.throws(()=>stepKeyRotation(plan,encodedCheckpoint,encoded.executor),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_EXECUTOR_RESULT'&&!String(error).includes(keyBase64));
 assert.equal(encoded.calls.reenvelope,1);
 assert.throws(()=>stepKeyRotation(plan,encodedCheckpoint,encoded.executor),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_EXECUTOR_RESULT'&&!String(error).includes(keyBase64));
 assert.equal(encoded.calls.reenvelope,1);
 assert.equal(encoded.calls.retire,0);

 const prose=custody({entries:sealed,current,next,candidateFor:()=>plaintext});
 let proseCheckpoint=beginKeyRotation(plan);
 proseCheckpoint=stepKeyRotation(plan,proseCheckpoint,prose.executor);
 assert.throws(()=>stepKeyRotation(plan,proseCheckpoint,prose.executor),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_EXECUTOR_RESULT'&&!String(error).includes(plaintext));
 assert.equal(JSON.stringify(proseCheckpoint).includes(plaintext),false);
 assert.equal(prose.calls.promote,0);

 const asFingerprint=custody({entries:sealed,current,next,candidateFor:()=>fingerprint});
 let fingerprintCheckpoint=beginKeyRotation(plan);
 fingerprintCheckpoint=stepKeyRotation(plan,fingerprintCheckpoint,asFingerprint.executor);
 const fingerprintBlocked=stepKeyRotation(plan,fingerprintCheckpoint,asFingerprint.executor);
 assert.equal(fingerprintBlocked.blockedReason,'KEY_ROTATION_MATERIAL_REJECTED');
 assert.equal(JSON.stringify(fingerprintBlocked).includes(fingerprint),false);
 assert.equal(asFingerprint.calls.promote,0);
 assert.equal(asFingerprint.installed.has(asFingerprint.oldFp),true);

 const opaque=custody({entries:sealed,current,next,candidateFor:entry=>digest({plain:plaintextHex,id:entry.id,version:entry.keyVersion})});
 const finished=run(plan,opaque.executor);
 assert.equal(finished.checkpoint.phase,'complete');
 const raw=[...opaque.records.values()].map(row=>row.candidateDigest);
 assertNoKeyMaterial([plan,finished.seen],[current,next],[plaintextHex,...raw]);
 for(const candidate of finished.checkpoint.candidates)assert.equal(raw.includes(candidate.commitment),false);
});

test('a changed durable digest is not promoted and a persisted checkpoint round-trips',()=>{
 const current=randomBytes(32),next=randomBytes(32);
 const plan=planFor(sealed,current,next);
 const store=custody({entries:sealed,current,next});
 let checkpoint=beginKeyRotation(plan);
 checkpoint=stepKeyRotation(plan,checkpoint,store.executor);
 checkpoint=stepKeyRotation(plan,JSON.parse(JSON.stringify(checkpoint)),store.executor);
 assert.equal(checkpoint.phase,'reenvelope');
 assert.equal(checkpoint.candidates.length,2);
 const diverged=custody({entries:sealed,current,next});
 diverged.records.set('a-entry/1',{id:'a-entry',keyVersion:1,candidateDigest:digest({changed:true})});
 const saved=JSON.parse(JSON.stringify(checkpoint)) as KeyRotationCheckpoint;
 assert.throws(()=>stepKeyRotation(JSON.parse(JSON.stringify(plan)),saved,diverged.executor),error=>error instanceof Refusal&&error.code==='KEY_ROTATION_OBSERVATION_DIVERGED');
 assert.equal(diverged.calls.reenvelope,0);
 assert.equal(diverged.calls.retire,0);
 const resumed=JSON.parse(JSON.stringify(checkpoint)) as KeyRotationCheckpoint;
 const finished=runFrom(JSON.parse(JSON.stringify(plan)),resumed,store);
 assert.equal(finished.phase,'complete');
 assert.equal(store.calls.reenvelope,3);
 assert.equal(store.calls.verify,3);
 assert.equal(store.calls.retire,1);
 assert.deepEqual(store.log,[
  'observe','observe','reenvelope','reenvelope','observe','reenvelope','observe','verify','verify','observe','verify','observe','promote','observe','retire',
 ]);
});
