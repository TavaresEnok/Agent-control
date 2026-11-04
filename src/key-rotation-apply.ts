import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {closeSync,fchmodSync,fstatSync,fsyncSync,lstatSync,openSync,readSync,readdirSync,realpathSync,renameSync,unlinkSync,writeSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {z} from 'zod';
import {digest,Id,Refusal} from './contracts.ts';
import {keyFingerprint} from './context-keys.ts';
import {sealCustodyEnvelope,unsealCustodyWithMasters} from './context-vault.ts';
import {beginKeyRotation,createKeyRotationPlan,parseKeyRotationCheckpoint,parseKeyRotationPlan,stepKeyRotation,type KeyRotationCheckpoint,type KeyRotationExecutor,type KeyRotationPlan} from './key-rotation-plan.ts';

/** File executor for a local custody master rotation. No ledger and no key material in the checkpoint. */

const MAX_CHECKPOINT_BYTES=16*1024*1024;
const ENTRY_NAME=/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([1-9][0-9]{0,9})\.vault$/;
const versionLimit=2_147_483_647;

export type KeyRotationApplyPoint=
 |'before-prepare'|'after-new-master'|'before-step'|'after-step'
 |'before-reenvelope'|'before-publish-rename'|'after-reenvelope'|'before-verify'|'after-verify'
 |'before-promote'|'before-retired-copy-write'|'after-master-copied'|'after-master-renamed'|'after-promote-entry'|'after-promote'
 |'before-retire'|'after-retire';

export type KeyRotationApplyEvent={
 point:KeyRotationApplyPoint;
 phase?:KeyRotationCheckpoint['phase'];
 index?:number;
 id?:string;
 keyVersion?:number;
};

export class KeyRotationInterrupted extends Error{
 constructor(readonly event:KeyRotationApplyEvent){super('KEY_ROTATION_INTERRUPTED');}
}

export type KeyRotationApplyRequest={
 root:string;
 masterFile:string;
 nextKeyVersion:number;
 nextMasterFile:string;
 checkpointFile:string;
 batchSize?:number;
 confirm:boolean;
 interrupt?:(event:KeyRotationApplyEvent)=>void;
};

export type KeyRotationApplyReport={
 schemaVersion:1;
 dryRun:boolean;
 applied:boolean;
 phase:string;
 nextKeyVersion:number;
 batchSize:number;
 planDigest?:string;
 entries:{id:string;keyVersion:number;state:'sealed'|'uncertain'|'corrupted'}[];
 blockers:{id:string;keyVersion:number;state:'uncertain'|'corrupted'}[];
 promoted:boolean;
 retired:boolean;
 blockedReason?:string;
};

type ListedEntry={id:string;keyVersion:number;path:string};
type ListedCandidate={id:string;keyVersion:number;planDigest:string;path:string};
type Scan={entries:ListedEntry[];candidates:ListedCandidate[]};

const inside=(parent:string,child:string)=>child===parent||child.startsWith(parent+sep);
const candidateName=(planDigest:string,entry:{id:string;keyVersion:number})=>`.rot-${planDigest}-${entry.id}-${entry.keyVersion}`;
const RESIDUE_NAME=/^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;
/** Fixed sibling of `masterFile`. Not a master: load and openKeys only read the active name, `.new` and `.old`. */
const RETIRED_TEMP=/^\.old\.tmp-[a-f0-9]{16}$/;
const PART_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_24=/^[a-f0-9]{24}$/;
const HEX_32=/^[a-f0-9]{32}$/;
const HEX_64=/^[a-f0-9]{64}$/;

function fire(request:KeyRotationApplyRequest,event:KeyRotationApplyEvent){
 if(!request.interrupt)return;
 request.interrupt(event);
}

function assertCanonical(path:string){
 if(!isAbsolute(path)||resolve(path)!==path)throw new Refusal('VAULT_PATH_UNSAFE',403);
 let real:string;
 try{real=realpathSync(path);}catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT'||(error as NodeJS.ErrnoException).code==='ELOOP')throw new Refusal('VAULT_PATH_UNSAFE',403);
  throw error;
 }
 if(real!==path)throw new Refusal('VAULT_PATH_UNSAFE',403);
}

function readPrivateSync(path:string,max:number){
 let fd:number;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){
  if((error as NodeJS.ErrnoException).code==='ELOOP')throw new Refusal('VAULT_PATH_UNSAFE',403);
  throw error;
 }
 try{
  const info=fstatSync(fd);
  if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>max)throw new Refusal('VAULT_FILE_UNSAFE',403);
  const data=Buffer.alloc(info.size);
  try{
   let offset=0;
   while(offset<data.length){
    const count=readSync(fd,data,offset,data.length-offset,offset);
    if(count===0)throw new Refusal('VAULT_FILE_UNSAFE',403);
    offset+=count;
   }
   return data;
  }catch(error){data.fill(0);throw error;}
 }finally{closeSync(fd);}
}

function readOptional(path:string,max:number){
 try{return readPrivateSync(path,max);}catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
  throw error;
 }
}

function existsPath(path:string){
 try{lstatSync(path);return true;}catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
  throw error;
 }
}

function syncDirectory(path:string){
 const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{fsyncSync(fd);}finally{closeSync(fd);}
}

function wipeAndUnlink(path:string){
 let fd:number;
 try{fd=openSync(path,constants.O_WRONLY|constants.O_NOFOLLOW);}catch(error){
  if((error as NodeJS.ErrnoException).code==='ELOOP')throw new Refusal('VAULT_PATH_UNSAFE',403);
  throw error;
 }
 try{
  const info=fstatSync(fd);
  if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600)throw new Refusal('VAULT_FILE_UNSAFE',403);
  const zeros=Buffer.alloc(info.size);
  try{
   let offset=0;
   while(offset<zeros.length){
    const count=writeSync(fd,zeros,offset,zeros.length-offset,offset);
    if(count===0)throw new Refusal('VAULT_FILE_UNSAFE',403);
    offset+=count;
   }
   fsyncSync(fd);
  }finally{zeros.fill(0);}
 }finally{closeSync(fd);}
 unlinkSync(path);
}

/** Durable bytes in a sibling `*.part`. The caller publishes that inode by rename. */
function writePrivateExclusive(path:string,bytes:Buffer){
 const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 let failed=false;
 try{
  fchmodSync(fd,0o600);
  let offset=0;
  while(offset<bytes.length){
   const count=writeSync(fd,bytes,offset,bytes.length-offset,offset);
   if(count===0)throw new Refusal('VAULT_FILE_UNSAFE',403);
   offset+=count;
  }
  fsyncSync(fd);
 }catch(error){failed=true;throw error;}
 finally{
  closeSync(fd);
  if(failed){try{wipeAndUnlink(path);}catch{/* the exclusive file is ours */}}
 }
}

/**
 * Publish only a complete file. A crash while writing leaves `.<name>.<uuid>.part`
 * and does not create or truncate `finalPath`. An injected interrupt keeps that residue.
 */
function publishExclusive(finalPath:string,bytes:Buffer,request:KeyRotationApplyRequest,event:KeyRotationApplyEvent){
 const temporary=join(dirname(finalPath),`.${basename(finalPath)}.${randomUUID()}.part`);
 writePrivateExclusive(temporary,bytes);
 let published=false;
 try{
  fire(request,event);
  if(existsPath(finalPath))throw new Refusal('VAULT_FILE_UNSAFE',403);
  renameSync(temporary,finalPath);
  published=true;
  syncDirectory(dirname(finalPath));
 }catch(error){
  if(!published&&!(error instanceof KeyRotationInterrupted)){try{wipeAndUnlink(temporary);}catch(cleanup){if((cleanup as NodeJS.ErrnoException).code!=='ENOENT')throw cleanup;}}
  throw error;
 }
}

/** Sibling left by `publishExclusive` for one final basename this rotation publishes. */
function ownedPartName(finalBase:string,name:string){
 const prefix=`.${finalBase}.`;
 if(!name.startsWith(prefix)||!name.endsWith('.part'))return false;
 return PART_UUID.test(name.slice(prefix.length,-'.part'.length));
}

/**
 * Wipe only incomplete publishes of this rotation: `masterFile.new`, this checkpoint,
 * and `.rot-<this plan>-<context>-<version>` once that plan is known. Other `*.part` files stay.
 */
function discardOwnedResidues(directory:string,finalBases:readonly string[]){
 if(!finalBases.length)return;
 const paths:string[]=[];
 for(const dirent of readdirSync(directory,{withFileTypes:true})){
  if(!finalBases.some(base=>ownedPartName(base,dirent.name)))continue;
  const path=join(directory,dirent.name);
  if(dirent.isSymbolicLink())throw new Refusal('VAULT_PATH_UNSAFE',403);
  const info=lstatSync(path);
  if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600)throw new Refusal('VAULT_FILE_UNSAFE',403);
  paths.push(path);
 }
 if(!paths.length)return;
 for(const path of paths)wipeAndUnlink(path);
 syncDirectory(directory);
}

function discardApplyResidues(request:KeyRotationApplyRequest,plan?:KeyRotationPlan){
 const groups=new Map<string,string[]>();
 const add=(directory:string,finalBase:string)=>{
  const bases=groups.get(directory)??[];
  bases.push(finalBase);
  groups.set(directory,bases);
 };
 add(dirname(request.masterFile),`${basename(request.masterFile)}.new`);
 add(dirname(request.checkpointFile),basename(request.checkpointFile));
 if(plan){
  const planDigest=beginKeyRotation(plan).planDigest;
  for(const entry of plan.entries){
   if(entry.state!=='sealed')continue;
   add(request.root,candidateName(planDigest,entry));
  }
 }
 for(const [directory,bases] of groups)discardOwnedResidues(directory,bases);
}

function sha256(bytes:Buffer){
 return createHash('sha256').update(bytes).digest('hex');
}

function parseEntryName(name:string){
 const match=ENTRY_NAME.exec(name);
 if(!match)return undefined;
 const keyVersion=Number(match[2]);
 if(!Number.isSafeInteger(keyVersion)||keyVersion<1||keyVersion>versionLimit)return undefined;
 const id=Id.safeParse(match[1]);
 if(!id.success)return undefined;
 return {id:id.data,keyVersion};
}

function assertPresentFile(path:string){
 const info=lstatSync(path);
 if(info.isSymbolicLink())throw new Refusal('VAULT_PATH_UNSAFE',403);
 assertCanonical(path);
}
function assertLayout(request:KeyRotationApplyRequest){
 assertCanonical(request.root);assertCanonical(request.nextMasterFile);
 if(!Number.isInteger(request.nextKeyVersion)||request.nextKeyVersion<1||request.nextKeyVersion>versionLimit)throw new Refusal('KEY_ROTATION_DESCRIPTOR_INVALID',400);
 const checkpointParent=dirname(request.checkpointFile);
 assertCanonical(checkpointParent);
 if(!isAbsolute(request.checkpointFile)||resolve(request.checkpointFile)!==request.checkpointFile)throw new Refusal('VAULT_PATH_UNSAFE',403);
 if(basename(request.checkpointFile)!==request.checkpointFile.slice(checkpointParent.length+1))throw new Refusal('VAULT_PATH_UNSAFE',403);
 const distinct=new Set([request.root,request.masterFile,request.nextMasterFile,request.checkpointFile]);
 if(distinct.size!==4)throw new Refusal('VAULT_PATH_UNSAFE',403);
 if(inside(request.root,request.checkpointFile)||inside(request.root,request.nextMasterFile))throw new Refusal('VAULT_PATH_UNSAFE',403);
 if(inside(request.masterFile,request.root))throw new Refusal('VAULT_PATH_UNSAFE',403);
 const rootInfo=lstatSync(request.root);
 if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||rootInfo.uid!==process.getuid?.()||(rootInfo.mode&0o777)!==0o700)throw new Refusal('VAULT_ROOT_UNSAFE',403);
 const parentInfo=lstatSync(checkpointParent);
 if(!parentInfo.isDirectory()||parentInfo.isSymbolicLink()||parentInfo.uid!==process.getuid?.()||(parentInfo.mode&0o077)!==0)throw new Refusal('VAULT_PATH_UNSAFE',403);
 if(existsPath(request.checkpointFile)){
  assertPresentFile(request.checkpointFile);
  const info=lstatSync(request.checkpointFile);
  if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600)throw new Refusal('VAULT_FILE_UNSAFE',403);
 }
 // promote publishes a complete masterFile.old by rename, then renames masterFile.new onto masterFile. The active name stays.
 if(!existsPath(request.masterFile))throw new Refusal('VAULT_PATH_UNSAFE',403);
 assertPresentFile(request.masterFile);
 for(const path of [request.masterFile,request.nextMasterFile,`${request.masterFile}.new`,`${request.masterFile}.old`]){
  if(path!==request.masterFile&&path!==request.nextMasterFile&&!existsPath(path))continue;
  if(path!==request.masterFile&&path!==request.nextMasterFile)assertPresentFile(path);
  readPrivateSync(path,32).fill(0);
 }
}

function scan(request:KeyRotationApplyRequest):Scan{
 const entries:ListedEntry[]=[];
 const candidates:ListedCandidate[]=[];
 const masterBase=inside(request.root,request.masterFile)?basename(request.masterFile):undefined;
 const ignored=new Set(masterBase?[masterBase,`${masterBase}.new`,`${masterBase}.old`]:[]);
 for(const dirent of readdirSync(request.root,{withFileTypes:true})){
  if(ignored.has(dirent.name))continue;
  const path=join(request.root,dirent.name);
  const info=lstatSync(path);
  if(info.isSymbolicLink())throw new Refusal('VAULT_PATH_UNSAFE',403);
  if(masterBase&&isRetiredTemporaryName(masterBase,dirent.name)){
   if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>32)throw new Refusal('VAULT_FILE_UNSAFE',403);
   continue;
  }
  if(RESIDUE_NAME.test(dirent.name)){
   if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600)throw new Refusal('VAULT_FILE_UNSAFE',403);
   continue;
  }
  const entry=parseEntryName(dirent.name);
  const candidate=/^\.rot-([a-f0-9]{64})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([1-9][0-9]{0,9})$/.exec(dirent.name);
  if(!entry&&!candidate)throw new Refusal('KEY_ROTATION_ENTRY_INVALID',400);
  if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600)throw new Refusal('VAULT_FILE_UNSAFE',403);
  if(entry){entries.push({...entry,path});continue;}
  const keyVersion=Number(candidate![3]);
  const id=Id.safeParse(candidate![2]);
  if(!id.success||keyVersion<1||keyVersion>versionLimit)throw new Refusal('KEY_ROTATION_ENTRY_INVALID',400);
  candidates.push({id:id.data,keyVersion,planDigest:candidate![1],path});
 }
 const seen=new Set<string>();
 for(const entry of entries){
  const identity=`${entry.id}\u0000${entry.keyVersion}`;
  if(seen.has(identity))throw new Refusal('KEY_ROTATION_DUPLICATE_ENTRY',409);
  seen.add(identity);
 }
 return {entries,candidates};
}

function classify(entries:readonly ListedEntry[],oldKey:Buffer):KeyRotationPlan['entries']{
 return entries.map(entry=>{
  let stored:Buffer|undefined;
  try{
   stored=readPrivateSync(entry.path,4096);
   try{
    const opened=unsealCustodyWithMasters([oldKey],stored);
    if(!opened)return {id:entry.id,keyVersion:entry.keyVersion,state:'corrupted' as const};
    try{
     if(opened.header.contextId!==entry.id||opened.header.version!==entry.keyVersion)return {id:entry.id,keyVersion:entry.keyVersion,state:'corrupted' as const};
     return {id:entry.id,keyVersion:entry.keyVersion,state:'sealed' as const};
    }finally{opened.plaintext.fill(0);}
   }catch(error){
    if(error instanceof Refusal&&error.code==='CONTEXT_KEY_UNAUTHORIZED')return {id:entry.id,keyVersion:entry.keyVersion,state:'corrupted' as const};
    if(error instanceof z.ZodError||error instanceof SyntaxError)return {id:entry.id,keyVersion:entry.keyVersion,state:'corrupted' as const};
    throw error;
   }
  }finally{stored?.fill(0);}
 });
}

function sameEntries(plan:KeyRotationPlan,entries:readonly ListedEntry[]){
 const planned=plan.entries.map(entry=>`${entry.id}\u0000${entry.keyVersion}`).sort();
 const found=entries.map(entry=>`${entry.id}\u0000${entry.keyVersion}`).sort();
 return planned.length===found.length&&planned.every((entry,index)=>entry===found[index]);
}

const Bundle=z.object({
 schemaVersion:z.literal(1),
 root:z.string(),
 masterFile:z.string(),
 nextMasterFile:z.string(),
 nextKeyVersion:z.number().int().positive().max(versionLimit),
 plan:z.unknown(),
 checkpoint:z.unknown(),
}).strict();

function loadBundle(request:KeyRotationApplyRequest){
 if(!existsPath(request.checkpointFile))return undefined;
 const bytes=readPrivateSync(request.checkpointFile,MAX_CHECKPOINT_BYTES);
 try{
  let parsed:unknown;
  try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT');}
  const bundle=Bundle.safeParse(parsed);
  if(!bundle.success)throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT');
  if(bundle.data.root!==request.root||bundle.data.masterFile!==request.masterFile||bundle.data.nextMasterFile!==request.nextMasterFile||bundle.data.nextKeyVersion!==request.nextKeyVersion)throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
  const plan=parseKeyRotationPlan(bundle.data.plan);
  const checkpoint=parseKeyRotationCheckpoint(bundle.data.checkpoint);
  if(checkpoint.planDigest!==beginKeyRotation(plan).planDigest)throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
  if(request.batchSize!==undefined&&request.batchSize!==plan.batchSize)throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
  return {plan,checkpoint};
 }finally{bytes.fill(0);}
}

function saveBundle(request:KeyRotationApplyRequest,plan:KeyRotationPlan,checkpoint:KeyRotationCheckpoint){
 const body=Buffer.from(JSON.stringify({schemaVersion:1,root:request.root,masterFile:request.masterFile,nextMasterFile:request.nextMasterFile,nextKeyVersion:request.nextKeyVersion,plan,checkpoint}));
 if(body.length>MAX_CHECKPOINT_BYTES){body.fill(0);throw new Refusal('KEY_ROTATION_LIMIT',400);}
 let temporary:string|undefined;
 try{
  if(existsPath(request.checkpointFile)){
   const prior=readPrivateSync(request.checkpointFile,MAX_CHECKPOINT_BYTES);
   try{if(prior.equals(body))return;}finally{prior.fill(0);}
  }
  temporary=join(dirname(request.checkpointFile),`.${basename(request.checkpointFile)}.${randomUUID()}.part`);
  writePrivateExclusive(temporary,body);
  renameSync(temporary,request.checkpointFile);
  temporary=undefined;
  syncDirectory(dirname(request.checkpointFile));
 }finally{
  body.fill(0);
  if(temporary){try{wipeAndUnlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 }
}

function reportOf(input:{dryRun:boolean;nextKeyVersion:number;plan?:KeyRotationPlan;checkpoint?:KeyRotationCheckpoint;entries:KeyRotationApplyReport['entries'];blockers:KeyRotationApplyReport['blockers'];blockedReason?:string;planDigest?:string;batchSize?:number}):{exitCode:0|3;report:KeyRotationApplyReport}{
 const blocked=input.blockedReason??input.checkpoint?.blockedReason;
 const report:KeyRotationApplyReport={
  schemaVersion:1,
  dryRun:input.dryRun,
  applied:input.checkpoint?.phase==='complete',
  phase:input.checkpoint?.phase??(blocked?'blocked':'prepare'),
  nextKeyVersion:input.nextKeyVersion,
  batchSize:input.plan?.batchSize??input.batchSize??32,
  entries:input.entries,
  blockers:input.blockers,
  promoted:input.checkpoint?.promoted??false,
  retired:input.checkpoint?.retired??false,
 };
 const planDigest=input.checkpoint?.planDigest??input.planDigest;
 if(planDigest)report.planDigest=planDigest;
 if(blocked)report.blockedReason=blocked;
 return {exitCode:blocked?3:0,report};
}

function openKeys(request:KeyRotationApplyRequest,plan:KeyRotationPlan){
 const buffers:Buffer[]=[];
 const take=(path:string)=>{
  const data=readOptional(path,32);
  if(!data)return undefined;
  if(data.length!==32){data.fill(0);throw new Refusal('VAULT_MASTER_INVALID',403);}
  buffers.push(data);
  return data;
 };
 const wipe=()=>{for(const buffer of buffers)buffer.fill(0);};
 try{
  // `masterFile.old.tmp-<digest>` is an unpublished copy. It is not a master and is not opened here.
  const active=take(request.masterFile),staged=take(`${request.masterFile}.new`),previous=take(`${request.masterFile}.old`);
  let oldKey:Buffer|undefined,newKey:Buffer|undefined;
  for(const key of [active,staged,previous]){
   if(!key)continue;
   const fingerprint=keyFingerprint(key);
   if(fingerprint===plan.oldKeyFingerprint)oldKey=key;
   else if(fingerprint===plan.newKeyFingerprint)newKey=key;
   else throw new Refusal('VAULT_MASTER_INVALID',403);
  }
  const activeFingerprint=active?keyFingerprint(active):previous?keyFingerprint(previous):staged?keyFingerprint(staged):undefined;
  if(!activeFingerprint)throw new Refusal('VAULT_MASTER_INVALID',403);
  return {oldKey,newKey,activeFingerprint,oldKeyInstalled:[active,staged,previous].some(key=>key?keyFingerprint(key)===plan.oldKeyFingerprint:false),wipe};
 }catch(error){wipe();throw error;}
}

function envelopeShaped(stored:Buffer){
 let value:unknown;
 try{value=JSON.parse(stored.toString('utf8'));}catch{return false;}
 if(!value||typeof value!=='object')return false;
 const body=value as {header?:unknown;nonce?:unknown;ciphertext?:unknown;tag?:unknown};
 return !!body.header&&typeof body.header==='object'&&typeof body.nonce==='string'&&HEX_24.test(body.nonce)&&typeof body.ciphertext==='string'&&HEX_64.test(body.ciphertext)&&typeof body.tag==='string'&&HEX_32.test(body.tag);
}

/** `torn` is an incomplete publish. A shaped envelope that fails authentication stays `corrupted`. */
function classifyCandidate(path:string,newKey:Buffer,entry:{id:string;keyVersion:number}):'verified'|'corrupted'|'torn'|'unsafe'|'missing'{
 if(!existsPath(path))return 'missing';
 let stored:Buffer|undefined;
 try{
  try{stored=readPrivateSync(path,4096);}catch(error){
   if(error instanceof Refusal&&(error.code==='VAULT_FILE_UNSAFE'||error.code==='VAULT_PATH_UNSAFE'))return 'unsafe';
   if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';
   throw error;
  }
  try{
   if(!envelopeShaped(stored))return 'torn';
   const opened=unsealCustodyWithMasters([newKey],stored);
   if(!opened)return 'corrupted';
   try{return opened.header.contextId===entry.id&&opened.header.version===entry.keyVersion?'verified':'corrupted';}
   finally{opened.plaintext.fill(0);}
  }catch(error){
   if(error instanceof Refusal&&error.code==='CONTEXT_KEY_UNAUTHORIZED')return 'corrupted';
   if(error instanceof z.ZodError||error instanceof SyntaxError)return 'corrupted';
   throw error;
  }
 }finally{stored?.fill(0);}
}

function fingerprintOf(path:string){
 const data=readOptional(path,32);
 if(!data)return undefined;
 try{if(data.length!==32)throw new Refusal('VAULT_MASTER_INVALID',403);return keyFingerprint(data);}
 finally{data.fill(0);}
}

function originalOpensWith(request:KeyRotationApplyRequest,entry:{id:string;keyVersion:number},key:Buffer){
 const stored=readPrivateSync(join(request.root,`${entry.id}-${entry.keyVersion}.vault`),4096);
 try{
  let opened:ReturnType<typeof unsealCustodyWithMasters>;
  try{opened=unsealCustodyWithMasters([key],stored);}catch(error){
   if(error instanceof Refusal&&error.code==='CONTEXT_KEY_UNAUTHORIZED')return false;
   if(error instanceof z.ZodError||error instanceof SyntaxError)return false;
   throw error;
  }
  try{return !!opened&&opened.header.contextId===entry.id&&opened.header.version===entry.keyVersion;}
  finally{opened?.plaintext.fill(0);}
 }finally{stored.fill(0);}
}

/** A published `masterFile.old` is the old master. A different 32-byte key is refused. */
function retiredMatches(retired:string,plan:KeyRotationPlan){
 const present=readPrivateSync(retired,32);
 try{
  if(present.length!==32)return false;
  if(keyFingerprint(present)!==plan.oldKeyFingerprint)throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
  return true;
 }finally{present.fill(0);}
}

function isRetiredTemporaryName(masterBase:string,name:string){
 return name.startsWith(masterBase)&&RETIRED_TEMP.test(name.slice(masterBase.length));
}

/** Same directory as `masterFile`, so the later rename is atomic. Sixteen hex chars of the plan digest. */
function retiredTemporaryPath(masterFile:string,plan:KeyRotationPlan){
 return `${masterFile}.old.tmp-${beginKeyRotation(plan).planDigest.slice(0,16)}`;
}

function removeRetiredTemporary(request:KeyRotationApplyRequest,plan:KeyRotationPlan){
 const temporary=retiredTemporaryPath(request.masterFile,plan);
 if(!existsPath(temporary))return;
 wipeAndUnlink(temporary);
 syncDirectory(dirname(request.masterFile));
}

/**
 * Durable bytes for `masterFile.old`. An interrupt while the body is still short leaves this
 * temporary in place and does not create `masterFile.old`.
 */
function writeRetiredTemporary(path:string,bytes:Buffer,request:KeyRotationApplyRequest){
 const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 let failed=false;
 try{
  fchmodSync(fd,0o600);
  const first=writeSync(fd,bytes,0,1,0);
  if(first!==1)throw new Refusal('VAULT_FILE_UNSAFE',403);
  fsyncSync(fd);
  fire(request,{point:'before-retired-copy-write',phase:'promote'});
  let offset=1;
  while(offset<bytes.length){
   const count=writeSync(fd,bytes,offset,bytes.length-offset,offset);
   if(count===0)throw new Refusal('VAULT_FILE_UNSAFE',403);
   offset+=count;
  }
  fsyncSync(fd);
 }catch(error){
  if(!(error instanceof KeyRotationInterrupted))failed=true;
  throw error;
 }finally{
  closeSync(fd);
  if(failed){try{wipeAndUnlink(path);}catch{/* the exclusive file is ours */}}
 }
}

/**
 * Publish a complete old master. The temporary is not a master name. If `masterFile.old` is already
 * the expected key, keep that inode and delete the temporary.
 */
function publishRetiredCopy(request:KeyRotationApplyRequest,plan:KeyRotationPlan){
 const retired=`${request.masterFile}.old`;
 const temporary=retiredTemporaryPath(request.masterFile,plan);
 const bytes=readPrivateSync(request.masterFile,32);
 try{
  if(bytes.length!==32||keyFingerprint(bytes)!==plan.oldKeyFingerprint)throw new Refusal('VAULT_MASTER_INVALID',403);
  writeRetiredTemporary(temporary,bytes,request);
  if(existsPath(retired)){
   if(!retiredMatches(retired,plan)){wipeAndUnlink(temporary);throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');}
   wipeAndUnlink(temporary);
  }else renameSync(temporary,retired);
  syncDirectory(dirname(request.masterFile));
  fire(request,{point:'after-master-copied',phase:'promote'});
 }finally{bytes.fill(0);}
}

/**
 * Publish the new master without removing `masterFile`.
 * `masterFile.old` appears only as a complete file, then `masterFile.new` replaces the active name.
 * Envelope swaps happen only after that rename.
 */
function installActiveMaster(request:KeyRotationApplyRequest,plan:KeyRotationPlan){
 const staged=`${request.masterFile}.new`,retired=`${request.masterFile}.old`;
 const active=fingerprintOf(request.masterFile);
 if(!active)throw new Refusal('VAULT_MASTER_INVALID',403);
 if(active===plan.newKeyFingerprint){
  if(existsPath(staged)||fingerprintOf(retired)!==plan.oldKeyFingerprint)throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
  removeRetiredTemporary(request,plan);
  return;
 }
 if(active!==plan.oldKeyFingerprint)throw new Refusal('VAULT_MASTER_INVALID',403);
 if(existsPath(retired)&&!retiredMatches(retired,plan)){
  wipeAndUnlink(retired);
  syncDirectory(dirname(request.masterFile));
 }
 removeRetiredTemporary(request,plan);
 if(!existsPath(retired))publishRetiredCopy(request,plan);
 if(fingerprintOf(staged)!==plan.newKeyFingerprint)throw new Refusal('VAULT_MASTER_INVALID',403);
 renameSync(staged,request.masterFile);
 syncDirectory(dirname(request.masterFile));
 fire(request,{point:'after-master-renamed',phase:'promote'});
}

function createExecutor(request:KeyRotationApplyRequest,plan:KeyRotationPlan):KeyRotationExecutor{
 const planDigest=beginKeyRotation(plan).planDigest;
 const sealed=plan.entries.filter(entry=>entry.state==='sealed');
 const candidatePath=(entry:{id:string;keyVersion:number})=>join(request.root,candidateName(planDigest,entry));
 const indexOf=(entry:{id:string;keyVersion:number})=>sealed.findIndex(item=>item.id===entry.id&&item.keyVersion===entry.keyVersion);
 return {
  observe(){
   const keys=openKeys(request,plan);
   try{
    const candidates=[];
    if(keys.newKey){
     for(const entry of sealed){
      const path=candidatePath(entry);
      if(classifyCandidate(path,keys.newKey,entry)!=='verified')continue;
      const stored=readPrivateSync(path,4096);
      try{candidates.push({id:entry.id,keyVersion:entry.keyVersion,candidateDigest:sha256(stored)});}finally{stored.fill(0);}
     }
    }
    const nextKey=keys.newKey;
    let activeKeyFingerprint=keys.activeFingerprint;
    // The plan treats a new active fingerprint as promotion already finished.
    // Report the old fingerprint until every original opens with the new master, so a crash
    // after installation and before the last envelope rename re-enters promote.
    if(nextKey&&keys.oldKey&&activeKeyFingerprint===plan.newKeyFingerprint&&sealed.some(entry=>!originalOpensWith(request,entry,nextKey)))activeKeyFingerprint=plan.oldKeyFingerprint;
    return {activeKeyFingerprint,oldKeyInstalled:keys.oldKeyInstalled,candidates,verifications:[]};
   }finally{keys.wipe();}
  },
  reenvelope(entry){
   const keys=openKeys(request,plan);
   let stored:Buffer|undefined,openedPlain:Buffer|undefined,envelope:Buffer|undefined;
   try{
    if(!keys.oldKey||!keys.newKey)throw new Refusal('VAULT_MASTER_INVALID',403);
    const path=candidatePath(entry);
    const index=indexOf(entry);
    const state=classifyCandidate(path,keys.newKey,entry);
    if(state==='unsafe')throw new Refusal('VAULT_FILE_UNSAFE',403);
    if(state==='verified'||state==='corrupted'){
     stored=readPrivateSync(path,4096);
     return {candidateDigest:sha256(stored)};
    }
    if(state==='torn'){wipeAndUnlink(path);syncDirectory(request.root);}
    fire(request,{point:'before-reenvelope',phase:'reenvelope',index,id:entry.id,keyVersion:entry.keyVersion});
    const original=join(request.root,`${entry.id}-${entry.keyVersion}.vault`);
    stored=readPrivateSync(original,4096);
    const opened=unsealCustodyWithMasters([keys.oldKey],stored);
    if(!opened||opened.header.contextId!==entry.id||opened.header.version!==entry.keyVersion)throw new Refusal('KEY_ROTATION_ENTRY_BLOCKED');
    openedPlain=opened.plaintext;
    envelope=sealCustodyEnvelope(keys.newKey,opened.header,openedPlain);
    publishExclusive(path,envelope,request,{point:'before-publish-rename',phase:'reenvelope',index,id:entry.id,keyVersion:entry.keyVersion});
    const candidateDigest=sha256(envelope);
    fire(request,{point:'after-reenvelope',phase:'reenvelope',index,id:entry.id,keyVersion:entry.keyVersion});
    return {candidateDigest};
   }finally{stored?.fill(0);openedPlain?.fill(0);envelope?.fill(0);keys.wipe();}
  },
  verify(entry){
   const keys=openKeys(request,plan);
   try{
    if(!keys.newKey)throw new Refusal('VAULT_MASTER_INVALID',403);
    const index=indexOf(entry);
    fire(request,{point:'before-verify',phase:'verify',index,id:entry.id,keyVersion:entry.keyVersion});
    const result=classifyCandidate(candidatePath(entry),keys.newKey,entry);
    fire(request,{point:'after-verify',phase:'verify',index,id:entry.id,keyVersion:entry.keyVersion});
    if(result==='unsafe')throw new Refusal('VAULT_FILE_UNSAFE',403);
    if(result==='missing'||result==='torn')return 'uncertain';
    return result;
   }finally{keys.wipe();}
  },
  promote(){
   const keys=openKeys(request,plan);
   try{
    if(!keys.oldKey||!keys.newKey)throw new Refusal('VAULT_MASTER_INVALID',403);
    fire(request,{point:'before-promote',phase:'promote'});
    installActiveMaster(request,plan);
    for(const entry of sealed){
     const original=join(request.root,`${entry.id}-${entry.keyVersion}.vault`);
     const candidate=candidatePath(entry);
     const current=readPrivateSync(original,4096);
     let alreadyNew=false;
     try{
      const opened=unsealCustodyWithMasters([keys.newKey],current);
      alreadyNew=!!opened&&opened.header.contextId===entry.id&&opened.header.version===entry.keyVersion;
      opened?.plaintext.fill(0);
     }catch(error){
      if(!(error instanceof Refusal&&error.code==='CONTEXT_KEY_UNAUTHORIZED')&&!(error instanceof z.ZodError)&&!(error instanceof SyntaxError))throw error;
     }finally{current.fill(0);}
     if(alreadyNew){if(existsPath(candidate))unlinkSync(candidate);continue;}
     const index=indexOf(entry);
     fire(request,{point:'before-promote',phase:'promote',index,id:entry.id,keyVersion:entry.keyVersion});
     if(classifyCandidate(candidate,keys.newKey,entry)!=='verified')throw new Refusal('KEY_ROTATION_VERIFICATION_FAILED');
     renameSync(candidate,original);
     syncDirectory(request.root);
     fire(request,{point:'after-promote-entry',phase:'promote',index,id:entry.id,keyVersion:entry.keyVersion});
    }
    syncDirectory(request.root);
    fire(request,{point:'after-promote',phase:'promote'});
   }finally{keys.wipe();}
  },
  retire(){
   const keys=openKeys(request,plan);
   try{
    if(!keys.newKey||keyFingerprint(keys.newKey)!==plan.newKeyFingerprint)throw new Refusal('KEY_ROTATION_RETIRE_FORBIDDEN');
    const active=readOptional(request.masterFile,32);
    try{if(!active||keyFingerprint(active)!==plan.newKeyFingerprint)throw new Refusal('KEY_ROTATION_RETIRE_FORBIDDEN');}
    finally{active?.fill(0);}
    fire(request,{point:'before-retire',phase:'retire'});
    for(const entry of sealed){
     const stored=readPrivateSync(join(request.root,`${entry.id}-${entry.keyVersion}.vault`),4096);
     try{
      const opened=unsealCustodyWithMasters([keys.newKey],stored);
      if(!opened||opened.header.contextId!==entry.id||opened.header.version!==entry.keyVersion)throw new Refusal('KEY_ROTATION_RETIRE_FORBIDDEN');
      opened.plaintext.fill(0);
     }finally{stored.fill(0);}
    }
    for(const entry of sealed){
     const path=candidatePath(entry);
     if(existsPath(path))unlinkSync(path);
    }
    syncDirectory(request.root);
    removeRetiredTemporary(request,plan);
    const retired=`${request.masterFile}.old`;
    if(existsPath(retired))unlinkSync(retired);
    syncDirectory(dirname(request.masterFile));
    if(dirname(request.masterFile)!==request.root)syncDirectory(request.root);
    fire(request,{point:'after-retire',phase:'retire'});
   }finally{keys.wipe();}
  },
 };
}

function ensureStagedMaster(request:KeyRotationApplyRequest,next:Buffer){
 const staged=`${request.masterFile}.new`;
 if(existsPath(staged)){
  const present=readPrivateSync(staged,32);
  try{
   if(present.length===32){
    if(!timingSafeEqual(present,next))throw new Refusal('VAULT_MASTER_INVALID',403);
    return;
   }
  }finally{present.fill(0);}
  wipeAndUnlink(staged);
  syncDirectory(dirname(request.masterFile));
 }
 fire(request,{point:'before-prepare'});
 publishExclusive(staged,next,request,{point:'before-publish-rename',phase:'prepare'});
 fire(request,{point:'after-new-master'});
}

function boundToPlan(request:KeyRotationApplyRequest,plan:KeyRotationPlan,current:Buffer,next:Buffer){
 if(keyFingerprint(next)!==plan.newKeyFingerprint)throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
 const currentFingerprint=keyFingerprint(current);
 if(currentFingerprint===plan.newKeyFingerprint){
  const previous=readOptional(`${request.masterFile}.old`,32);
  try{if(previous&&keyFingerprint(previous)!==plan.oldKeyFingerprint)throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');}
  finally{previous?.fill(0);}
  return;
 }
 if(currentFingerprint!==plan.oldKeyFingerprint)throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
}

/** Apply or preview one rotation. Without `confirm` this only reads. Checkpoints store ids, versions and digests. */
export function applyContextKeyRotation(request:KeyRotationApplyRequest):{exitCode:0|3;report:KeyRotationApplyReport}{
 assertLayout(request);
 if(request.batchSize!==undefined&&(!Number.isInteger(request.batchSize)||request.batchSize<1||request.batchSize>256))throw new Refusal('KEY_ROTATION_LIMIT',400);
 const scanned=scan(request);
 const current=readOptional(request.masterFile,32)??readOptional(`${request.masterFile}.old`,32);
 const next=readPrivateSync(request.nextMasterFile,32);
 try{
  if(!current||current.length!==32||next.length!==32)throw new Refusal('VAULT_MASTER_INVALID',403);
  if(!scanned.entries.length)throw new Refusal('KEY_ROTATION_EMPTY',409);
  const saved=loadBundle(request);
  if(!saved&&scanned.candidates.length)throw new Refusal('KEY_ROTATION_ENTRY_INVALID',400);
  if(saved&&!sameEntries(saved.plan,scanned.entries))throw new Refusal('KEY_ROTATION_CHECKPOINT_MISMATCH');
  if(saved&&scanned.candidates.some(candidate=>candidate.planDigest!==saved.checkpoint.planDigest||!saved.plan.entries.some(entry=>entry.id===candidate.id&&entry.keyVersion===candidate.keyVersion)))throw new Refusal('KEY_ROTATION_ENTRY_INVALID',400);
  if(!saved&&timingSafeEqual(current,next)){
   const entries=classify(scanned.entries,current);
   return reportOf({dryRun:!request.confirm,nextKeyVersion:request.nextKeyVersion,entries,blockers:entries.flatMap(entry=>entry.state==='sealed'?[]:[{id:entry.id,keyVersion:entry.keyVersion,state:entry.state}]),blockedReason:'KEY_ROTATION_UNCHANGED',batchSize:request.batchSize});
  }
  if(saved)boundToPlan(request,saved.plan,current,next);
  const entries=saved?saved.plan.entries.map(entry=>({id:entry.id,keyVersion:entry.keyVersion,state:entry.state})):classify(scanned.entries,current);
  const blockers=entries.flatMap(entry=>entry.state==='sealed'?[]:[{id:entry.id,keyVersion:entry.keyVersion,state:entry.state}]);
  if(!saved&&blockers.length)return reportOf({dryRun:!request.confirm,nextKeyVersion:request.nextKeyVersion,entries,blockers,blockedReason:'KEY_ROTATION_ENTRY_BLOCKED',batchSize:request.batchSize});
  if(!request.confirm){
   if(saved)return reportOf({dryRun:true,nextKeyVersion:request.nextKeyVersion,plan:saved.plan,checkpoint:saved.checkpoint,entries:saved.plan.entries,blockers:saved.plan.blockers});
   const plan=createKeyRotationPlan({entries,currentKey:current,nextKey:next,batchSize:request.batchSize});
   const checkpoint=beginKeyRotation(plan);
   return reportOf({dryRun:true,nextKeyVersion:request.nextKeyVersion,plan,checkpoint,entries:plan.entries,blockers:plan.blockers,planDigest:checkpoint.planDigest});
  }
  discardApplyResidues(request,saved?.plan);
  if(saved){
   if(keyFingerprint(current)===saved.plan.oldKeyFingerprint)ensureStagedMaster(request,next);
  }else ensureStagedMaster(request,next);
  const plan=saved?.plan??createKeyRotationPlan({entries,currentKey:current,nextKey:next,batchSize:request.batchSize});
  let checkpoint=saved?.checkpoint??beginKeyRotation(plan);
  saveBundle(request,plan,checkpoint);
  const executor=createExecutor(request,plan);
  const limit=plan.entries.length*4+8;
  for(let step=0;step<limit;step++){
   fire(request,{point:'before-step',phase:checkpoint.phase});
   const nextCheckpoint=stepKeyRotation(plan,checkpoint,executor);
   saveBundle(request,plan,nextCheckpoint);
   fire(request,{point:'after-step',phase:nextCheckpoint.phase});
   if(nextCheckpoint.phase==='complete'||nextCheckpoint.phase==='blocked')return reportOf({dryRun:false,nextKeyVersion:request.nextKeyVersion,plan,checkpoint:nextCheckpoint,entries:plan.entries,blockers:plan.blockers});
   if(digest(nextCheckpoint)===digest(checkpoint))throw new Refusal('KEY_ROTATION_CHECKPOINT_CORRUPT');
   checkpoint=nextCheckpoint;
  }
  throw new Refusal('KEY_ROTATION_LIMIT',400);
 }finally{current?.fill(0);next.fill(0);}
}
