import {z} from 'zod';
import {Refusal,digest} from './contracts.ts';
import {explainDiskAdmission,requiredFreeBytes} from './disk-admission.ts';

/** Pure dry-run. There is no apply path and no filesystem walk. Callers supply
 * the inventory and the disk observation; this module only classifies them. */

const Bytes=z.number().int().safe().nonnegative();
const Token=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const Kind=z.enum(['acceptance_evidence','evidence','log','backup','worktree','cache']);
const Artifact=z.object({
 id:Token,
 kind:Kind,
 ageMs:z.number().int().safe().nonnegative(),
 sizeBytes:Bytes,
 state:z.enum(['active','idle','uncertain']),
 references:z.array(z.object({jobId:Token,status:z.enum(['active','uncertain','released'])}).strict()).max(32),
 regenerable:z.boolean().optional(),
 restoreProven:z.boolean().optional(),
 backupGroup:Token.optional(),
 acceptance:z.boolean().optional(),
}).strict();
const Inventory=z.object({schemaVersion:z.literal(1),artifacts:z.array(Artifact).max(1000)}).strict();
const Policy=z.object({
 schemaVersion:z.literal(1),
 minAgeMs:z.object({cache:Bytes,log:Bytes,worktree:Bytes,backup:Bytes}).strict(),
 disk:z.object({
  availableBytes:Bytes,
  minFreeBytes:Bytes,
  estimatedWriteBytes:z.number().int().safe().positive(),
  additionalReservedBytes:Bytes.optional(),
 }).strict(),
}).strict();
type Artifact=z.infer<typeof Artifact>;
type Policy=z.infer<typeof Policy>;
export type RetentionDecision={id:string;kind:Artifact['kind'];action:'keep'|'propose';code:string;reason:string;sizeBytes:number};
export type RetentionPlan={
 schemaVersion:1;mode:'dry-run';deletesNothing:true;
 policy:{minAgeMs:Policy['minAgeMs'];disk:{availableBytes:string;minFreeBytes:string;estimatedWriteBytes:string;additionalReservedBytes:string}};
 admission:{admitted:boolean;code:'ADMITTED'|'STORAGE_LOW_SPACE';reason:string;availableBytes:string;requiredBytes:string};
 decisions:RetentionDecision[];proposalOrder:string[];proposedBytes:number;digest:string;
};

const REASON:Record<string,string>={
 ACCEPTANCE_EVIDENCE:'Acceptance evidence is preserved.',
 EVIDENCE_PRESERVED:'Evidence is preserved because this policy has no proof it is disposable.',
 STATE_UNCERTAIN:'Uncertain artifact state is preserved.',
 REFERENCED_BY_UNCERTAIN_JOB:'Artifact referenced by an uncertain job is preserved.',
 REFERENCED_BY_ACTIVE_JOB:'Artifact referenced by an active job is preserved.',
 STATE_ACTIVE:'Active artifact is preserved.',
 BACKUP_RESTORE_UNPROVEN:'Backup without a proven restore is preserved.',
 BACKUP_GROUP_UNKNOWN:'Backup without a group cannot be proved redundant and is preserved.',
 UNIQUE_VALID_BACKUP:'The only valid backup in its group is preserved.',
 RETAIN_NEWEST_VALID_BACKUP:'The newest valid backup in its group is preserved.',
 ZERO_SIZE:'Empty artifact is not a cleanup candidate.',
 NOT_REGENERABLE:'Cache without an explicit regenerable mark is preserved.',
 BELOW_MIN_AGE:'Artifact is inside its retention age and is preserved.',
 PROPOSE_AGED_CACHE:'Regenerable cache is past its retention age. Dry-run proposal only.',
 DISK_FULL_REGENERABLE_CACHE:'Disk admission is refused. Regenerable cache is listed first. Dry-run proposal only.',
 PROPOSE_AGED_LOG:'Idle log is past its retention age. Dry-run proposal only.',
 PROPOSE_IDLE_WORKTREE:'Idle unreferenced worktree is past its retention age. Dry-run proposal only.',
 PROPOSE_REDUNDANT_PROVEN_BACKUP:'Older backup has a proven restore and another valid backup remains. Dry-run proposal only.',
};
const PROPOSE=new Set(['PROPOSE_AGED_CACHE','DISK_FULL_REGENERABLE_CACHE','PROPOSE_AGED_LOG','PROPOSE_IDLE_WORKTREE','PROPOSE_REDUNDANT_PROVEN_BACKUP']);
const TIER:Record<string,number>={DISK_FULL_REGENERABLE_CACHE:0,PROPOSE_AGED_CACHE:0,PROPOSE_AGED_LOG:1,PROPOSE_IDLE_WORKTREE:2,PROPOSE_REDUNDANT_PROVEN_BACKUP:3};

function parse<T>(schema:z.ZodType<T>,value:unknown,code:string):T{
 try{return schema.parse(value);}catch{throw new Refusal(code,400);}
}
function byId(a:Artifact,b:Artifact){return a.id<b.id?-1:a.id>b.id?1:0;}
function countsAsValid(item:Artifact){
 return item.kind==='backup'&&item.restoreProven===true&&item.state!=='uncertain'&&item.acceptance!==true&&item.backupGroup!==undefined;
}
function referenceCode(item:Artifact){
 if(item.references.some(reference=>reference.status==='uncertain'))return 'REFERENCED_BY_UNCERTAIN_JOB';
 if(item.references.some(reference=>reference.status==='active'))return 'REFERENCED_BY_ACTIVE_JOB';
 return undefined;
}
function keepCode(item:Artifact,backupRole:Map<string,'UNIQUE_VALID_BACKUP'|'RETAIN_NEWEST_VALID_BACKUP'>){
 if(item.acceptance===true||item.kind==='acceptance_evidence')return 'ACCEPTANCE_EVIDENCE';
 if(item.kind==='evidence')return 'EVIDENCE_PRESERVED';
 if(item.state==='uncertain')return 'STATE_UNCERTAIN';
 const referenced=referenceCode(item);if(referenced)return referenced;
 if(item.state==='active')return 'STATE_ACTIVE';
 if(item.kind==='backup'&&item.restoreProven!==true)return 'BACKUP_RESTORE_UNPROVEN';
 if(item.kind==='backup'&&item.backupGroup===undefined)return 'BACKUP_GROUP_UNKNOWN';
 const role=item.kind==='backup'?backupRole.get(item.id):undefined;if(role)return role;
 if(item.sizeBytes===0)return 'ZERO_SIZE';
 if(item.kind==='cache'&&item.regenerable!==true)return 'NOT_REGENERABLE';
 return undefined;
}
function classify(item:Artifact,diskFull:boolean,policy:Policy,backupRole:Map<string,'UNIQUE_VALID_BACKUP'|'RETAIN_NEWEST_VALID_BACKUP'>){
 const kept=keepCode(item,backupRole);
 if(kept)return kept;
 if(item.kind==='cache'){
  if(diskFull)return 'DISK_FULL_REGENERABLE_CACHE';
  return item.ageMs>=policy.minAgeMs.cache?'PROPOSE_AGED_CACHE':'BELOW_MIN_AGE';
 }
 if(item.kind==='log')return item.ageMs>=policy.minAgeMs.log?'PROPOSE_AGED_LOG':'BELOW_MIN_AGE';
 if(item.kind==='worktree')return item.ageMs>=policy.minAgeMs.worktree?'PROPOSE_IDLE_WORKTREE':'BELOW_MIN_AGE';
 if(item.kind==='backup')return item.ageMs>=policy.minAgeMs.backup?'PROPOSE_REDUNDANT_PROVEN_BACKUP':'BELOW_MIN_AGE';
 return 'EVIDENCE_PRESERVED';
}
function decision(item:Artifact,code:string):RetentionDecision{
 const reason=REASON[code];if(!reason)throw new Refusal('RETENTION_PLAN_INVALID',400);
 return {id:item.id,kind:item.kind,action:PROPOSE.has(code)?'propose':'keep',code,reason,sizeBytes:item.sizeBytes};
}

export function planRetention(inventory:unknown,policy:unknown):RetentionPlan{
 const items=parse(Inventory,inventory,'RETENTION_INVENTORY_INVALID').artifacts;
 const rules=parse(Policy,policy,'RETENTION_POLICY_INVALID');
 const seen=new Set<string>();
 for(const item of items){
  if(seen.has(item.id))throw new Refusal('RETENTION_DUPLICATE_ID',400);
  seen.add(item.id);
  if(item.kind==='acceptance_evidence'&&item.acceptance===false)throw new Refusal('RETENTION_INVENTORY_INVALID',400);
  if(item.kind!=='backup'&&(item.backupGroup!==undefined||item.restoreProven!==undefined))throw new Refusal('RETENTION_INVENTORY_INVALID',400);
  if(item.kind!=='cache'&&item.regenerable!==undefined)throw new Refusal('RETENTION_INVENTORY_INVALID',400);
 }
 const groups=new Map<string,Artifact[]>();
 for(const item of items){
  if(!countsAsValid(item)||!item.backupGroup)continue;
  groups.set(item.backupGroup,[...groups.get(item.backupGroup)??[],item]);
 }
 const backupRole=new Map<string,'UNIQUE_VALID_BACKUP'|'RETAIN_NEWEST_VALID_BACKUP'>();
 for(const group of groups.values()){
  const ranked=group.slice().sort((a,b)=>a.ageMs-b.ageMs||byId(a,b));
  const keeper=ranked[0];if(!keeper)continue;
  // The newest valid copy stays even when older proven copies exist.
  backupRole.set(keeper.id,ranked.length===1?'UNIQUE_VALID_BACKUP':'RETAIN_NEWEST_VALID_BACKUP');
 }
 const reserved=rules.disk.additionalReservedBytes??0;
 const requiredBytes=requiredFreeBytes(rules.disk.minFreeBytes,rules.disk.estimatedWriteBytes,BigInt(reserved));
 const verdict=explainDiskAdmission(BigInt(rules.disk.availableBytes),requiredBytes);
 const diskFull=!verdict.admitted;
 const ranked=items.map(item=>({item,code:classify(item,diskFull,rules,backupRole)}));
 const proposals=ranked.filter(entry=>PROPOSE.has(entry.code)).slice().sort((a,b)=>{
  const tier=(TIER[a.code]??9)-(TIER[b.code]??9);if(tier)return tier;
  if(a.item.sizeBytes!==b.item.sizeBytes)return b.item.sizeBytes-a.item.sizeBytes;
  if(a.item.ageMs!==b.item.ageMs)return b.item.ageMs-a.item.ageMs;
  return byId(a.item,b.item);
 });
 let proposed=0n;
 for(const entry of proposals){
  proposed+=BigInt(entry.item.sizeBytes);
  if(proposed>BigInt(Number.MAX_SAFE_INTEGER))throw new Refusal('RETENTION_BYTES_UNSAFE',400);
 }
 const decisions=ranked.map(entry=>decision(entry.item,entry.code)).slice().sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const body={
  schemaVersion:1 as const,mode:'dry-run' as const,deletesNothing:true as const,
  policy:{
   minAgeMs:rules.minAgeMs,
   disk:{
    availableBytes:String(rules.disk.availableBytes),minFreeBytes:String(rules.disk.minFreeBytes),
    estimatedWriteBytes:String(rules.disk.estimatedWriteBytes),additionalReservedBytes:String(reserved),
   },
  },
  admission:{admitted:verdict.admitted,code:verdict.code,reason:verdict.reason,availableBytes:String(rules.disk.availableBytes),requiredBytes:String(requiredBytes)},
  decisions,proposalOrder:proposals.map(entry=>entry.item.id),proposedBytes:Number(proposed),
 };
 return {...body,digest:digest(body)};
}
