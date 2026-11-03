import {z} from 'zod';
import {digest,Refusal} from './contracts.ts';
import {keyFingerprint} from './context-keys.ts';

/** In-memory rotation plan for the local custody wrapping key. No vault I/O. */

export const KEY_ROTATION_DEFAULT_BATCH_SIZE=32;
export const KEY_ROTATION_MAX_ENTRIES=10_000;
export const KEY_ROTATION_PHASES=['prepare','reenvelope','verify','promote','retire'] as const;

const sha=z.string().regex(/^[a-f0-9]{64}$/);
const HEX_64=/^[a-f0-9]{64}$/;
const entryId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const keyVersion=z.number().int().positive().max(2_147_483_647);
const EntryState=z.enum(['sealed','uncertain','corrupted']);
const InventoryEntry=z.object({id:entryId,keyVersion,state:EntryState}).strict();
const Candidate=z.object({id:entryId,keyVersion,commitment:sha}).strict();
const Verification=z.object({id:entryId,keyVersion,result:z.enum(['verified','uncertain','corrupted'])}).strict();
const BlockedReason=z.enum([
 'KEY_ROTATION_SOURCE_MISMATCH','KEY_ROTATION_ENTRY_BLOCKED','KEY_ROTATION_VERIFICATION_FAILED','KEY_ROTATION_MATERIAL_REJECTED',
]);
const Plan=z.object({
 schemaVersion:z.literal(1),
 kind:z.literal('context-vault-key-rotation'),
 phases:z.tuple([z.literal('prepare'),z.literal('reenvelope'),z.literal('verify'),z.literal('promote'),z.literal('retire')]),
 oldKeyFingerprint:sha,
 newKeyFingerprint:sha,
 materialSeals:z.array(sha).length(6),
 batchSize:z.number().int().min(1).max(256),
 entries:z.array(InventoryEntry).min(1).max(KEY_ROTATION_MAX_ENTRIES),
 blockers:z.array(z.object({id:entryId,keyVersion,state:z.enum(['uncertain','corrupted'])}).strict()).max(KEY_ROTATION_MAX_ENTRIES),
}).strict();
const Checkpoint=z.object({
 schemaVersion:z.literal(1),
 planDigest:sha,
 phase:z.enum(['prepare','reenvelope','verify','promote','retire','complete','blocked']),
 candidates:z.array(Candidate).max(KEY_ROTATION_MAX_ENTRIES),
 verifications:z.array(Verification).max(KEY_ROTATION_MAX_ENTRIES),
 promoted:z.boolean(),
 retired:z.boolean(),
 blockedReason:BlockedReason.optional(),
}).strict();
const Observation=z.object({
 activeKeyFingerprint:sha,
 oldKeyInstalled:z.boolean(),
 candidates:z.array(z.object({id:entryId,keyVersion,candidateDigest:sha}).strict()).max(KEY_ROTATION_MAX_ENTRIES),
 verifications:z.array(Verification).max(KEY_ROTATION_MAX_ENTRIES),
}).strict();

export type KeyRotationPlan=z.infer<typeof Plan>;
export type KeyRotationCheckpoint=z.infer<typeof Checkpoint>;
export type RotationEntryRef={id:string;keyVersion:number};
/**
 * Durable port. `observe` is read-only and must already show every effect that completed,
 * including one whose checkpoint was never saved. A later step adopts that observation
 * and does not call the effect again. Returned digests are not stored; only a commitment is.
 * `reenvelope` keeps the envelope under the old key. `promote` leaves the old key installed.
 * `retire` is the only call that may remove it.
 */
export type KeyRotationExecutor={
 observe():z.infer<typeof Observation>;
 reenvelope(entry:RotationEntryRef):{candidateDigest:string};
 verify(entry:RotationEntryRef):'verified'|'uncertain'|'corrupted';
 promote(request:{oldKeyFingerprint:string;newKeyFingerprint:string}):void;
 retire(request:{oldKeyFingerprint:string}):void;
};

type Identity={id:string;keyVersion:number};
type ObservedCandidate=Identity&{candidateDigest:string};
type ObservedVerification=z.infer<typeof Verification>;
const identityOf=(entry:Identity)=>`${entry.id}\u0000${entry.keyVersion}`;
const sameIdentity=(left:Identity,right:Identity)=>left.id===right.id&&left.keyVersion===right.keyVersion;
const sealedEntries=(plan:KeyRotationPlan)=>plan.entries.filter(entry=>entry.state==='sealed');
const matchesList=(part:readonly Identity[],full:readonly Identity[])=>part.length===full.length&&part.every((entry,index)=>sameIdentity(entry,full[index]!));
const isPrefix=(part:readonly Identity[],full:readonly Identity[])=>part.length<=full.length&&part.every((entry,index)=>sameIdentity(entry,full[index]!));
const materialSeal=(encoding:string)=>digest({kind:'key-rotation-material',encoding});

function copyCheckpoint(checkpoint:KeyRotationCheckpoint):KeyRotationCheckpoint{
 return Checkpoint.parse(structuredClone(checkpoint));
}
function finish(base:KeyRotationCheckpoint,patch:{
 phase:KeyRotationCheckpoint['phase'];candidates?:KeyRotationCheckpoint['candidates'];verifications?:KeyRotationCheckpoint['verifications'];
 promoted?:boolean;retired?:boolean;blockedReason?:KeyRotationCheckpoint['blockedReason'];
}):KeyRotationCheckpoint{
 const next:KeyRotationCheckpoint={
  schemaVersion:1,planDigest:base.planDigest,phase:patch.phase,
  candidates:patch.candidates??base.candidates,verifications:patch.verifications??base.verifications,
  promoted:patch.promoted??false,retired:patch.retired??false,
 };
 if(patch.blockedReason)next.blockedReason=patch.blockedReason;
 return Checkpoint.parse(next);
}
function ready(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint){
 const sealed=sealedEntries(plan);
 return plan.blockers.length===0
  &&plan.entries.length===sealed.length
  &&matchesList(checkpoint.candidates,sealed)
  &&matchesList(checkpoint.verifications,sealed)
  &&checkpoint.verifications.every(entry=>entry.result==='verified');
}
function encodingsOf(key:Uint8Array){
 const bytes=Buffer.from(key);
 try{return [bytes.toString('hex'),bytes.toString('base64'),bytes.toString('base64url')];}
 finally{bytes.fill(0);}
}
function screenDigest(plan:KeyRotationPlan,value:string):'ok'|'material'|'malformed'{
 if(!HEX_64.test(value))return 'malformed';
 if(value===plan.oldKeyFingerprint||value===plan.newKeyFingerprint)return 'material';
 if(plan.materialSeals.includes(value)||plan.materialSeals.includes(materialSeal(value)))return 'material';
 return 'ok';
}
function assertArtifact(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint){
 const walk=(node:unknown)=>{
  if(typeof node==='string'){
   if(screenDigest(plan,node)==='material')throw new Refusal('KEY_ROTATION_MATERIAL_REJECTED');
   return;
  }
  if(Array.isArray(node)){for(const item of node)walk(item);return;}
  if(node!==null&&typeof node==='object')for(const value of Object.values(node))walk(value);
 };
 walk(checkpoint);
}
function candidateCommitment(plan:KeyRotationPlan,entry:Identity,executorDigest:string){
 if(screenDigest(plan,executorDigest)!=='ok')throw new Refusal('KEY_ROTATION_MATERIAL_REJECTED');
 const commitment=digest({schemaVersion:1,kind:'context-vault-key-rotation-candidate',planDigest:digest(plan),id:entry.id,keyVersion:entry.keyVersion,executorDigest});
 if(screenDigest(plan,commitment)!=='ok'||commitment===executorDigest)throw new Refusal('KEY_ROTATION_MATERIAL_REJECTED');
 return commitment;
}
function assertCoherent(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint){
 const sealed=sealedEntries(plan);
 const corrupt=()=>{throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT')};
 if(checkpoint.retired&&!checkpoint.promoted)corrupt();
 if(checkpoint.phase==='prepare'){
  if(checkpoint.candidates.length||checkpoint.verifications.length||checkpoint.promoted||checkpoint.retired||checkpoint.blockedReason)corrupt();
  return;
 }
 if(checkpoint.phase==='reenvelope'){
  if(plan.blockers.length||checkpoint.verifications.length||checkpoint.promoted||checkpoint.retired||checkpoint.blockedReason)corrupt();
  if(!isPrefix(checkpoint.candidates,sealed))corrupt();
  return;
 }
 if(checkpoint.phase==='verify'){
  if(plan.blockers.length||checkpoint.promoted||checkpoint.retired||checkpoint.blockedReason)corrupt();
  if(!matchesList(checkpoint.candidates,sealed)||!isPrefix(checkpoint.verifications,sealed))corrupt();
  if(checkpoint.verifications.some(entry=>entry.result!=='verified'))corrupt();
  return;
 }
 if(checkpoint.phase==='promote'){
  if(checkpoint.promoted||checkpoint.retired||checkpoint.blockedReason||!ready(plan,checkpoint))corrupt();
  return;
 }
 if(checkpoint.phase==='retire'){
  if(!checkpoint.promoted||checkpoint.retired||checkpoint.blockedReason||!ready(plan,checkpoint))corrupt();
  return;
 }
 if(checkpoint.phase==='complete'){
  if(!checkpoint.promoted||!checkpoint.retired||checkpoint.blockedReason||!ready(plan,checkpoint))corrupt();
  return;
 }
 if(!checkpoint.blockedReason||checkpoint.promoted||checkpoint.retired)corrupt();
 if(checkpoint.blockedReason==='KEY_ROTATION_SOURCE_MISMATCH'||checkpoint.blockedReason==='KEY_ROTATION_ENTRY_BLOCKED'){
  if(checkpoint.candidates.length||checkpoint.verifications.length)corrupt();
  if(checkpoint.blockedReason==='KEY_ROTATION_ENTRY_BLOCKED'&&!plan.blockers.length)corrupt();
  return;
 }
 if(checkpoint.blockedReason==='KEY_ROTATION_MATERIAL_REJECTED'){
  if(!isPrefix(checkpoint.candidates,sealed)||checkpoint.verifications.length>checkpoint.candidates.length)corrupt();
  if(checkpoint.verifications.some((entry,index)=>entry.result!=='verified'||!sameIdentity(entry,checkpoint.candidates[index]!)))corrupt();
  return;
 }
 if(checkpoint.blockedReason!=='KEY_ROTATION_VERIFICATION_FAILED')corrupt();
 if(plan.blockers.length||!matchesList(checkpoint.candidates,sealed)||!isPrefix(checkpoint.verifications,sealed)||!checkpoint.verifications.length)corrupt();
 const prior=checkpoint.verifications.slice(0,-1),last=checkpoint.verifications.at(-1);
 if(!last||last.result==='verified'||prior.some(entry=>entry.result!=='verified'))corrupt();
}

/**
 * Bind a rotation to fingerprints of the current and next wrapping keys.
 * Copies of the key bytes are wiped before return. The plan stores seals of the key
 * encodings, never the encodings themselves, and no plaintext.
 */
export function createKeyRotationPlan(input:{entries:unknown;currentKey:Uint8Array;nextKey:Uint8Array;batchSize?:number}):KeyRotationPlan{
 const current=Buffer.from(input.currentKey),next=Buffer.from(input.nextKey);
 try{
  if(current.byteLength!==32||next.byteLength!==32)throw new Refusal('INVALID_CONTEXT_KEY',403);
  const batchSize=input.batchSize??KEY_ROTATION_DEFAULT_BATCH_SIZE;
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>256)throw new Refusal('KEY_ROTATION_LIMIT',400);
  if(!Array.isArray(input.entries))throw new Refusal('KEY_ROTATION_LIMIT',400);
  if(input.entries.length<1)throw new Refusal('KEY_ROTATION_EMPTY',409);
  if(input.entries.length>KEY_ROTATION_MAX_ENTRIES)throw new Refusal('KEY_ROTATION_LIMIT',400);
  const oldKeyFingerprint=keyFingerprint(current),newKeyFingerprint=keyFingerprint(next);
  if(oldKeyFingerprint===newKeyFingerprint)throw new Refusal('KEY_ROTATION_UNCHANGED',409);
  const leaked=[...encodingsOf(current),...encodingsOf(next)];
  if(input.entries.some(entry=>typeof entry==='object'&&entry!==null&&'id'in entry&&leaked.some(secret=>String((entry as {id:unknown}).id).includes(secret))))throw new Refusal('KEY_ROTATION_MATERIAL_REJECTED',409);
  const entries=z.array(InventoryEntry).parse(input.entries).map(entry=>({id:entry.id,keyVersion:entry.keyVersion,state:entry.state}));
  const seen=new Set<string>();
  for(const entry of entries){
   const identity=identityOf(entry);
   if(seen.has(identity))throw new Refusal('KEY_ROTATION_DUPLICATE_ENTRY',409);
   seen.add(identity);
  }
  entries.sort((left,right)=>left.id<right.id?-1:left.id>right.id?1:left.keyVersion-right.keyVersion);
  const blockers=entries.filter(entry=>entry.state!=='sealed').map(entry=>({id:entry.id,keyVersion:entry.keyVersion,state:entry.state as 'uncertain'|'corrupted'}));
  const materialSeals=[...new Set(leaked.map(materialSeal))].sort();
  return Plan.parse({
   schemaVersion:1,kind:'context-vault-key-rotation',phases:[...KEY_ROTATION_PHASES],
   oldKeyFingerprint,newKeyFingerprint,materialSeals,batchSize,entries,blockers,
  });
 }finally{current.fill(0);next.fill(0);}
}

/** Checkpoint before any executor effect. Safe to persist: it has no key material. */
export function beginKeyRotation(planInput:unknown):KeyRotationCheckpoint{
 const plan=Plan.parse(planInput);
 const checkpoint:KeyRotationCheckpoint={schemaVersion:1,planDigest:digest(plan),phase:'prepare',candidates:[],verifications:[],promoted:false,retired:false};
 assertArtifact(plan,checkpoint);
 return checkpoint;
}

function readObservation(executor:KeyRotationExecutor):z.infer<typeof Observation>{
 const parsed=Observation.safeParse(executor.observe());
 if(!parsed.success)throw new Refusal('KEY_ROTATION_EXECUTOR_RESULT');
 return parsed.data;
}
function indexObservations(plan:KeyRotationPlan,observation:z.infer<typeof Observation>){
 const sealed=new Set(sealedEntries(plan).map(identityOf));
 const candidates=new Map<string,ObservedCandidate>();
 const verifications=new Map<string,ObservedVerification>();
 const verificationIds=new Set<string>();
 let material=false;
 for(const candidate of observation.candidates){
  const identity=identityOf(candidate);
  const screen=screenDigest(plan,candidate.candidateDigest);
  if(screen==='malformed')throw new Refusal('KEY_ROTATION_EXECUTOR_RESULT');
  if(screen==='material'){material=true;continue;}
  if(!sealed.has(identity)||candidates.has(identity))throw new Refusal('KEY_ROTATION_EXECUTOR_RESULT');
  candidates.set(identity,candidate);
 }
 for(const verification of observation.verifications){
  const identity=identityOf(verification);
  if(verificationIds.has(identity))throw new Refusal('KEY_ROTATION_EXECUTOR_RESULT');
  verificationIds.add(identity);
  if(!sealed.has(identity)||(!candidates.has(identity)&&!material))throw new Refusal('KEY_ROTATION_EXECUTOR_RESULT');
  if(candidates.has(identity))verifications.set(identity,verification);
 }
 return {candidates,verifications,material};
}
function mergeCandidates(plan:KeyRotationPlan,recorded:readonly KeyRotationCheckpoint['candidates'][number][],observed:ReadonlyMap<string,ObservedCandidate>){
 const merged:KeyRotationCheckpoint['candidates']=[];
 for(const entry of sealedEntries(plan)){
  const prior=recorded[merged.length];
  const seen=observed.get(identityOf(entry));
  if(prior){
   if(!sameIdentity(prior,entry))throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT');
   if(seen&&candidateCommitment(plan,entry,seen.candidateDigest)!==prior.commitment)throw new Refusal('KEY_ROTATION_OBSERVATION_DIVERGED');
   merged.push(prior);
   continue;
  }
  if(!seen)break;
  merged.push({id:entry.id,keyVersion:entry.keyVersion,commitment:candidateCommitment(plan,entry,seen.candidateDigest)});
 }
 if(recorded.length>merged.length)throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT');
 return merged;
}
function mergeVerifications(entries:readonly Identity[],recorded:readonly ObservedVerification[],observed:ReadonlyMap<string,ObservedVerification>){
 const merged:ObservedVerification[]=[];
 for(const entry of entries){
  const prior=recorded[merged.length];
  const seen=observed.get(identityOf(entry));
  if(prior){
   if(!sameIdentity(prior,entry))throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT');
   if(seen&&seen.result!==prior.result)throw new Refusal('KEY_ROTATION_OBSERVATION_DIVERGED');
   merged.push(prior);
   if(prior.result!=='verified')break;
   continue;
  }
  if(!seen)break;
  merged.push({id:entry.id,keyVersion:entry.keyVersion,result:seen.result});
  if(seen.result!=='verified')break;
 }
 if(recorded.length>merged.length)throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT');
 return merged;
}
function reconcile(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint,observation:z.infer<typeof Observation>):KeyRotationCheckpoint{
 const active=observation.activeKeyFingerprint;
 const indexed=indexObservations(plan,observation);
 if(indexed.material){
  if(active!==plan.oldKeyFingerprint)throw new Refusal('KEY_ROTATION_PROMOTE_FORBIDDEN');
  if(!observation.oldKeyInstalled)throw new Refusal('KEY_ROTATION_RETIRE_FORBIDDEN');
  const candidates=mergeCandidates(plan,checkpoint.candidates,indexed.candidates);
  const verifications=mergeVerifications(candidates,checkpoint.verifications,indexed.verifications).filter(entry=>entry.result==='verified');
  return finish(checkpoint,{phase:'blocked',candidates,verifications,promoted:false,retired:false,blockedReason:'KEY_ROTATION_MATERIAL_REJECTED'});
 }
 if(active!==plan.oldKeyFingerprint&&active!==plan.newKeyFingerprint){
  if(!checkpoint.candidates.length&&!checkpoint.verifications.length&&!checkpoint.promoted&&!checkpoint.retired)return finish(checkpoint,{phase:'blocked',candidates:[],verifications:[],blockedReason:'KEY_ROTATION_SOURCE_MISMATCH'});
  throw new Refusal('KEY_ROTATION_OBSERVATION_DIVERGED');
 }
 if(plan.blockers.length){
  if(active!==plan.oldKeyFingerprint)throw new Refusal('KEY_ROTATION_PROMOTE_FORBIDDEN');
  if(!observation.oldKeyInstalled)throw new Refusal('KEY_ROTATION_RETIRE_FORBIDDEN');
  return finish(checkpoint,{phase:'blocked',candidates:[],verifications:[],blockedReason:'KEY_ROTATION_ENTRY_BLOCKED'});
 }
 const sealed=sealedEntries(plan);
 const candidates=mergeCandidates(plan,checkpoint.candidates,indexed.candidates);
 const verifications=mergeVerifications(candidates,checkpoint.verifications,indexed.verifications);
 const failed=verifications.at(-1)?.result!==undefined&&verifications.at(-1)!.result!=='verified';
 const allVerified=candidates.length===sealed.length&&verifications.length===sealed.length&&verifications.every(entry=>entry.result==='verified');
 if(checkpoint.promoted&&active!==plan.newKeyFingerprint)throw new Refusal('KEY_ROTATION_OBSERVATION_DIVERGED');
 if(active===plan.newKeyFingerprint&&!allVerified)throw new Refusal('KEY_ROTATION_PROMOTE_FORBIDDEN');
 if(!observation.oldKeyInstalled&&!(allVerified&&(checkpoint.promoted||active===plan.newKeyFingerprint)))throw new Refusal('KEY_ROTATION_RETIRE_FORBIDDEN');
 if(checkpoint.retired&&observation.oldKeyInstalled)throw new Refusal('KEY_ROTATION_OBSERVATION_DIVERGED');
 if(failed)return finish(checkpoint,{phase:'blocked',candidates,verifications,promoted:false,retired:false,blockedReason:'KEY_ROTATION_VERIFICATION_FAILED'});
 const promoted=checkpoint.promoted||(active===plan.newKeyFingerprint&&allVerified);
 const retired=promoted&&allVerified&&!observation.oldKeyInstalled;
 if(retired)return finish(checkpoint,{phase:'complete',candidates,verifications,promoted:true,retired:true});
 if(promoted)return finish(checkpoint,{phase:'retire',candidates,verifications,promoted:true,retired:false});
 if(allVerified)return finish(checkpoint,{phase:'promote',candidates,verifications,promoted:false,retired:false});
 if(candidates.length===sealed.length)return finish(checkpoint,{phase:'verify',candidates,verifications,promoted:false,retired:false});
 if(candidates.length>0||checkpoint.phase==='reenvelope')return finish(checkpoint,{phase:'reenvelope',candidates,verifications,promoted:false,retired:false});
 return finish(checkpoint,{phase:checkpoint.phase,candidates,verifications,promoted:false,retired:false});
}
function acceptedDigest(plan:KeyRotationPlan,entry:Identity,value:unknown){
 if(!value||typeof value!=='object'||typeof (value as {candidateDigest?:unknown}).candidateDigest!=='string')throw new Refusal('KEY_ROTATION_EXECUTOR_RESULT');
 const candidateDigest=(value as {candidateDigest:string}).candidateDigest;
 const screen=screenDigest(plan,candidateDigest);
 if(screen==='malformed')throw new Refusal('KEY_ROTATION_EXECUTOR_RESULT');
 if(screen==='material')return {material:true as const};
 return {material:false as const,commitment:candidateCommitment(plan,entry,candidateDigest)};
}
function reenvelope(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint,executor:KeyRotationExecutor,observed:ReadonlyMap<string,ObservedCandidate>){
 const sealed=sealedEntries(plan);
 const batch=sealed.slice(checkpoint.candidates.length,checkpoint.candidates.length+plan.batchSize);
 const added=checkpoint.candidates.slice();
 for(const entry of batch){
  if(observed.has(identityOf(entry)))throw new Refusal('KEY_ROTATION_OBSERVATION_DIVERGED');
  const accepted=acceptedDigest(plan,entry,executor.reenvelope({id:entry.id,keyVersion:entry.keyVersion}));
  if(accepted.material)return finish(checkpoint,{phase:'blocked',candidates:added,verifications:[],promoted:false,retired:false,blockedReason:'KEY_ROTATION_MATERIAL_REJECTED'});
  added.push({id:entry.id,keyVersion:entry.keyVersion,commitment:accepted.commitment});
 }
 return finish(checkpoint,{phase:added.length===sealed.length?'verify':'reenvelope',candidates:added,verifications:[],promoted:false,retired:false});
}
function verify(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint,executor:KeyRotationExecutor){
 const sealed=sealedEntries(plan);
 const batch=sealed.slice(checkpoint.verifications.length,checkpoint.verifications.length+plan.batchSize);
 const verifications=checkpoint.verifications.slice();
 for(const entry of batch){
  const candidate=checkpoint.candidates[verifications.length];
  if(!candidate||!sameIdentity(candidate,entry))throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT');
  const result=executor.verify({id:entry.id,keyVersion:entry.keyVersion});
  if(result!=='verified'&&result!=='uncertain'&&result!=='corrupted')throw new Refusal('KEY_ROTATION_EXECUTOR_RESULT');
  verifications.push({id:entry.id,keyVersion:entry.keyVersion,result});
  if(result!=='verified')return finish(checkpoint,{phase:'blocked',candidates:checkpoint.candidates,verifications,promoted:false,retired:false,blockedReason:'KEY_ROTATION_VERIFICATION_FAILED'});
 }
 return finish(checkpoint,{phase:verifications.length===sealed.length?'promote':'verify',candidates:checkpoint.candidates,verifications,promoted:false,retired:false});
}
function promote(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint,executor:KeyRotationExecutor,observation:z.infer<typeof Observation>){
 if(!ready(plan,checkpoint)||checkpoint.promoted||observation.activeKeyFingerprint!==plan.oldKeyFingerprint)throw new Refusal('KEY_ROTATION_PROMOTE_FORBIDDEN');
 executor.promote({oldKeyFingerprint:plan.oldKeyFingerprint,newKeyFingerprint:plan.newKeyFingerprint});
 return finish(checkpoint,{phase:'retire',promoted:true,retired:false});
}
function retire(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint,executor:KeyRotationExecutor,observation:z.infer<typeof Observation>){
 if(!checkpoint.promoted||!ready(plan,checkpoint)||checkpoint.retired||!observation.oldKeyInstalled)throw new Refusal('KEY_ROTATION_RETIRE_FORBIDDEN');
 executor.retire({oldKeyFingerprint:plan.oldKeyFingerprint});
 return finish(checkpoint,{phase:'complete',promoted:true,retired:true});
}

/**
 * Apply one resumable unit. Durable effects already visible through `observe` are adopted
 * and not repeated, so a crash after the effect and before this return is saved does not
 * replay promote, retire or a finished batch entry. A thrown executor error leaves the
 * previous checkpoint as the caller's last saved value. Blocked and complete checkpoints
 * are stable and perform no further effects.
 */
export function stepKeyRotation(planInput:unknown,checkpointInput:unknown,executor:KeyRotationExecutor):KeyRotationCheckpoint{
 const plan=Plan.parse(planInput);
 const checkpoint=Checkpoint.parse(checkpointInput);
 if(checkpoint.planDigest!==digest(plan))throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
 assertArtifact(plan,checkpoint);
 assertCoherent(plan,checkpoint);
 if(checkpoint.phase==='complete'||checkpoint.phase==='blocked')return emit(plan,copyCheckpoint(checkpoint));
 const observation=readObservation(executor);
 const adopted=reconcile(plan,checkpoint,observation);
 if(digest(adopted)!==digest(checkpoint))return emit(plan,adopted);
 const indexed=indexObservations(plan,observation);
 if(checkpoint.phase==='prepare')return emit(plan,finish(checkpoint,{phase:'reenvelope',candidates:[],verifications:[],promoted:false,retired:false}));
 if(checkpoint.phase==='reenvelope')return emit(plan,reenvelope(plan,checkpoint,executor,indexed.candidates));
 if(checkpoint.phase==='verify')return emit(plan,verify(plan,checkpoint,executor));
 if(checkpoint.phase==='promote')return emit(plan,promote(plan,checkpoint,executor,observation));
 return emit(plan,retire(plan,checkpoint,executor,observation));
}
function emit(plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint){
 assertArtifact(plan,checkpoint);
 assertCoherent(plan,checkpoint);
 return checkpoint;
}
