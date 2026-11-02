import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,statfs} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {unlink} from 'node:fs/promises';
import {z} from 'zod';
import type pg from 'pg';
import {Authority,Id,Refusal,digest} from './contracts.ts';
import {Ledger} from './ledger.ts';

const Bytes=z.number().int().safe().nonnegative();
const PoolPolicy=z.object({minFreeBytes:Bytes,budgetBytes:Bytes.positive(),maxObjectBytes:Bytes.positive().max(64*1024*1024)}).strict();
const Allocation=z.object({id:Id,grantId:Id,category:z.enum(['disposable_cache','disposable_diagnostic']),
 bytes:Bytes.positive(),retainSeconds:z.number().int().min(0).max(365*86400)}).strict();
type Row={id:string;pool_id:string;context_id:string;grant_id:string;request_digest:string;reserved_bytes:string;
 object_bytes:string|null;object_sha256:string|null;state:string;held:boolean;retain_until:Date};
type Pool={id:string;path_digest:string;device:string;inode:string;min_free_bytes:string;budget_bytes:string;max_object_bytes:string;revision:number};
export type RetentionPlan={schemaVersion:1;poolId:string;poolRevision:number;candidates:{id:string;sha256:string;bytes:number}[];digest:string};

/** Controller-owned disposable spool only. Never point this at a worker mount,
 * repository, transcript, backup, canonical log or evidence directory. Linux
 * directory FDs pin the parent during publication and removal; no recursion,
 * globbing, external command, symlink following or unknown-file deletion. */
export class StoragePool {
 constructor(readonly ledger:Ledger,readonly id:string,private readonly path:string){
  Id.parse(id);if(!isAbsolute(path)||resolve(path)!==path)throw new Refusal('STORAGE_PATH_INVALID',400);
 }
 private async directory(){
  if(await realpath(this.path)!==this.path)throw new Refusal('STORAGE_PATH_SYMLINK');
  const fd=await open(this.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const info=await fd.stat({bigint:true});
   if(!info.isDirectory()||info.uid!==BigInt(process.getuid!())||(info.mode&0o077n)!==0n)throw new Refusal('STORAGE_DIRECTORY_NOT_PRIVATE');
   return {fd,device:String(info.dev),inode:String(info.ino)};
  }catch(error){await fd.close();throw error;}
 }
 private async admin(c:pg.PoolClient,principal:string){
  if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
 }
 private async locked(c:pg.PoolClient,dir:{device:string;inode:string}){
  const pool=(await c.query<Pool>('SELECT * FROM ac_storage_pools WHERE id=$1 FOR UPDATE',[this.id])).rows[0];
  if(!pool||pool.path_digest!==digest(this.path)||pool.device!==dir.device||pool.inode!==dir.inode)throw new Refusal('STORAGE_POOL_IDENTITY_MISMATCH');
  return pool;
 }
 async configure(principal:string,raw:z.infer<typeof PoolPolicy>,expectedRevision:number){
  const policy=PoolPolicy.parse(raw);z.number().int().nonnegative().parse(expectedRevision);
  if(policy.maxObjectBytes>policy.budgetBytes)throw new Refusal('STORAGE_OBJECT_EXCEEDS_BUDGET',400);
  const dir=await this.directory();try{return await this.ledger.tx(async c=>{
   await this.admin(c,principal);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['storage:'+this.id]);
   const current=(await c.query<Pool>('SELECT * FROM ac_storage_pools WHERE id=$1 FOR UPDATE',[this.id])).rows[0];
   if((current?.revision??0)!==expectedRevision)throw new Refusal('STORAGE_POLICY_CONFLICT');
   if(current)await this.locked(c,dir);
   const used=BigInt((await c.query("SELECT COALESCE(sum(reserved_bytes),0)::text used FROM ac_storage_allocations WHERE pool_id=$1 AND state<>'deleted'",[this.id])).rows[0].used);
   if(used>BigInt(policy.budgetBytes))throw new Refusal('STORAGE_BUDGET_BELOW_RESERVATIONS');
   const row=(await c.query(`INSERT INTO ac_storage_pools(id,path_digest,device,inode,min_free_bytes,budget_bytes,max_object_bytes)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET min_free_bytes=$5,budget_bytes=$6,max_object_bytes=$7,
    revision=ac_storage_pools.revision+1,updated_at=now() RETURNING revision`,
    [this.id,digest(this.path),dir.device,dir.inode,policy.minFreeBytes,policy.budgetBytes,policy.maxObjectBytes])).rows[0];
   return row.revision as number;
  });}finally{await dir.fd.close();}
 }
 async reserve(principal:string,authority:Authority,raw:z.infer<typeof Allocation>){
  const input=Allocation.parse(raw),hash=digest(input),dir=await this.directory();
  try{return await this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
   if(!grant||grant.context_id!==authority.contextId||Number(grant.manager_epoch)!==authority.epoch||grant.state==='released')throw new Refusal('STORAGE_GRANT_NOT_ACTIVE');
   await this.ledger.assertIntentActive(c,authority.contextId,grant.intent_id);
   const pool=await this.locked(c,dir);
   const prior=(await c.query<Row>('SELECT * FROM ac_storage_allocations WHERE id=$1',[input.id])).rows[0];
   if(prior){if(prior.request_digest!==hash||prior.context_id!==authority.contextId||prior.pool_id!==this.id)throw new Refusal('STORAGE_ALLOCATION_CONFLICT');return prior;}
   if(BigInt(input.bytes)>BigInt(pool.max_object_bytes))throw new Refusal('STORAGE_OBJECT_TOO_LARGE');
   const used=BigInt((await c.query("SELECT COALESCE(sum(reserved_bytes),0)::text used FROM ac_storage_allocations WHERE pool_id=$1 AND state<>'deleted'",[this.id])).rows[0].used);
   if(used+BigInt(input.bytes)>BigInt(pool.budget_bytes))throw new Refusal('STORAGE_BUDGET_EXHAUSTED');
   const fs=await statfs('/proc/self/fd/'+dir.fd.fd,{bigint:true});
   // Conservative: subtract all outstanding reservations, including already
   // materialized bytes. Never rely on a forecast to consume the safety floor.
   if(fs.bavail*fs.bsize-used-BigInt(input.bytes)<BigInt(pool.min_free_bytes))throw new Refusal('STORAGE_LOW_SPACE');
   const saved=(await c.query<Row>(`INSERT INTO ac_storage_allocations(id,pool_id,context_id,grant_id,request_digest,category,reserved_bytes,state,retain_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',clock_timestamp()+$8*interval '1 second') RETURNING *`,
    [input.id,this.id,authority.contextId,input.grantId,hash,input.category,input.bytes,input.retainSeconds])).rows[0];
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'storage.reserved',$2)",[authority.contextId,{allocationId:input.id,poolId:this.id,bytes:input.bytes}]);
   return saved;
  });}finally{await dir.fd.close();}
 }
 async publish(principal:string,authority:Authority,id:string,content:Uint8Array){
  Id.parse(id);const dir=await this.directory();
  try{return await this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);
   await this.locked(c,dir);
   const row=(await c.query<Row>('SELECT * FROM ac_storage_allocations WHERE id=$1 AND pool_id=$2 FOR UPDATE',[id,this.id])).rows[0];
   if(!row||row.context_id!==authority.contextId)throw new Refusal('STORAGE_ALLOCATION_FORBIDDEN',403);
   const grant=(await c.query('SELECT state,manager_epoch,intent_id FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[row.grant_id])).rows[0];
   if(grant.state==='released'||Number(grant.manager_epoch)!==authority.epoch)throw new Refusal('STORAGE_GRANT_NOT_ACTIVE');
   await this.ledger.assertIntentActive(c,authority.contextId,grant.intent_id);
   const hash=createHash('sha256').update(content).digest('hex');
   if(row.state==='published'&&row.object_sha256===hash&&Number(row.object_bytes)===content.byteLength){
    const existing=await open(`/proc/self/fd/${dir.fd.fd}/${id}.blob`,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const info=await existing.stat(),actual=createHash('sha256');
     if(!info.isFile()||info.nlink!==1||info.size!==content.byteLength||info.uid!==process.getuid!())throw new Refusal('STORAGE_OBJECT_UNSAFE');
     for await(const chunk of existing.createReadStream({autoClose:false}))actual.update(chunk);
     if(actual.digest('hex')!==hash)throw new Refusal('STORAGE_OBJECT_CHANGED');
    }finally{await existing.close();}return;
   }
   if(row.state!=='reserved'||BigInt(content.byteLength)>BigInt(row.reserved_bytes))throw new Refusal('STORAGE_PUBLICATION_REFUSED');
   const file=await open(`/proc/self/fd/${dir.fd.fd}/${id}.blob`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(content);await file.sync();}finally{await file.close();}
   await dir.fd.sync();
   await c.query("UPDATE ac_storage_allocations SET state='published',object_bytes=$2,object_sha256=$3,updated_at=now() WHERE id=$1",[id,content.byteLength,hash]);
  });}finally{await dir.fd.close();}
 }
 /** Holds default to true. Only an administrator can release a cache for
  * retention after the grant is physically reconciled/released by Capacity. */
 async releaseForRetention(principal:string,id:string){
  Id.parse(id);await this.ledger.tx(async c=>{
   await this.admin(c,principal);
   const row=(await c.query<Row>('SELECT * FROM ac_storage_allocations WHERE id=$1 AND pool_id=$2 FOR UPDATE',[id,this.id])).rows[0];
   if(!row||row.state!=='published')throw new Refusal('STORAGE_NOT_PUBLISHED');
   if(!(await c.query("SELECT 1 FROM ac_capacity_grants WHERE id=$1 AND state='released'",[row.grant_id])).rowCount)throw new Refusal('STORAGE_ACTIVE_GRANT');
   await c.query("UPDATE ac_storage_allocations SET held=false,state='retained',updated_at=now() WHERE id=$1",[id]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'storage.retention.released',$2)",[row.context_id,{allocationId:id,poolId:this.id}]);
  });
 }
 /** A never-published reservation can be closed only after reconciled physical
  * release and proof that its file is absent. A partial/unknown file is kept. */
 async releaseUnpublished(principal:string,id:string){
  Id.parse(id);const dir=await this.directory();try{await this.ledger.tx(async c=>{
   await this.admin(c,principal);await this.locked(c,dir);
   const row=(await c.query<Row>('SELECT * FROM ac_storage_allocations WHERE id=$1 AND pool_id=$2 FOR UPDATE',[id,this.id])).rows[0];
   if(!row||row.state!=='reserved'||row.object_sha256!==null)throw new Refusal('STORAGE_NOT_UNPUBLISHED');
   if(!(await c.query("SELECT 1 FROM ac_capacity_grants WHERE id=$1 AND state='released'",[row.grant_id])).rowCount)throw new Refusal('STORAGE_ACTIVE_GRANT');
   let absent=false;
   try{const file=await open(`/proc/self/fd/${dir.fd.fd}/${id}.blob`,constants.O_RDONLY|constants.O_NOFOLLOW);await file.close();}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')absent=true;else throw new Refusal('STORAGE_OBJECT_UNSAFE');}
   if(!absent)throw new Refusal('STORAGE_UNPUBLISHED_EFFECT_UNCERTAIN');
   await c.query("UPDATE ac_storage_allocations SET state='deleted',held=false,updated_at=now() WHERE id=$1",[id]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'storage.unpublished.closed',$2)",[row.context_id,{allocationId:id,poolId:this.id}]);
  });}finally{await dir.fd.close();}
 }
 private async candidates(c:pg.PoolClient){return (await c.query<Row>(`SELECT a.* FROM ac_storage_allocations a JOIN ac_capacity_grants g ON g.id=a.grant_id
  WHERE a.pool_id=$1 AND a.state IN ('retained','deleting') AND NOT a.held AND a.retain_until<=clock_timestamp()
  AND g.state='released' AND a.object_sha256 IS NOT NULL ORDER BY a.id LIMIT 1000 FOR UPDATE OF a`,[this.id])).rows;}
 async plan(principal:string):Promise<RetentionPlan>{
  const dir=await this.directory();try{return await this.ledger.tx(async c=>{
   await this.admin(c,principal);const pool=await this.locked(c,dir);
   const candidates=(await this.candidates(c)).map(row=>({id:row.id,sha256:row.object_sha256!,bytes:Number(row.object_bytes)}));
   const value={schemaVersion:1 as const,poolId:this.id,poolRevision:pool.revision,candidates};return {...value,digest:digest(value)};
  });}finally{await dir.fd.close();}
 }
 async apply(principal:string,expected:RetentionPlan){
  const parsed=z.object({schemaVersion:z.literal(1),poolId:Id,poolRevision:z.number().int().positive(),
   candidates:z.array(z.object({id:Id,sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:Bytes}).strict()).max(10000),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(expected);
  const {digest:hash,...payload}=parsed;if(parsed.poolId!==this.id||digest(payload)!==hash)throw new Refusal('STORAGE_RETENTION_PLAN_INVALID');
  const dir=await this.directory();let removed=0;
  try{for(const candidate of parsed.candidates)await this.ledger.tx(async c=>{
   await this.admin(c,principal);const pool=await this.locked(c,dir);
   if(pool.revision!==parsed.poolRevision)throw new Refusal('STORAGE_POLICY_CONFLICT');
   const row=(await this.candidates(c)).find(item=>item.id===candidate.id);
   if(!row||row.object_sha256!==candidate.sha256||Number(row.object_bytes)!==candidate.bytes)throw new Refusal('STORAGE_RETENTION_PLAN_STALE');
   const filename=`/proc/self/fd/${dir.fd.fd}/${candidate.id}.blob`;
   let file:FileHandle;
   try{file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||row.state!=='deleting')throw new Refusal('STORAGE_OBJECT_MISSING_OR_UNSAFE');
    await c.query("UPDATE ac_storage_allocations SET state='deleted',updated_at=now() WHERE id=$1",[candidate.id]);return;}
   try{const info=await file.stat();
    if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid!()||info.size!==candidate.bytes)throw new Refusal('STORAGE_OBJECT_UNSAFE');
    const hasher=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false}))hasher.update(chunk);
    if(hasher.digest('hex')!==candidate.sha256)throw new Refusal('STORAGE_OBJECT_CHANGED');
   }finally{await file.close();}
   // Persist deletion intent before the unlink. The pool row lock is retained
   // in this transaction; restart with a missing file is conservative unless
   // the prior 'deleting' transition was committed by the prepare below.
   await c.query("UPDATE ac_storage_allocations SET state='deleting',updated_at=now() WHERE id=$1",[candidate.id]);
  });
  // Second, independently committed phase: unknown/missing files cannot become
  // eligible merely because a previous filesystem operation threw an error.
  for(const candidate of parsed.candidates)await this.ledger.tx(async c=>{
   await this.admin(c,principal);const pool=await this.locked(c,dir);
   if(pool.revision!==parsed.poolRevision)throw new Refusal('STORAGE_POLICY_CONFLICT');
   const row=(await this.candidates(c)).find(item=>item.id===candidate.id);
   if(!row){const prior=(await c.query('SELECT state FROM ac_storage_allocations WHERE id=$1 AND pool_id=$2',[candidate.id,this.id])).rows[0];if(prior?.state==='deleted')return;throw new Refusal('STORAGE_RETENTION_PLAN_STALE');}
   if(row.state!=='deleting'||row.object_sha256!==candidate.sha256||Number(row.object_bytes)!==candidate.bytes)throw new Refusal('STORAGE_RETENTION_PLAN_STALE');
   const filename=`/proc/self/fd/${dir.fd.fd}/${candidate.id}.blob`;
   let file:FileHandle|undefined;
   try{file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();
    if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid!()||info.size!==candidate.bytes)throw new Refusal('STORAGE_OBJECT_UNSAFE');
    const hash=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);
    if(hash.digest('hex')!==candidate.sha256)throw new Refusal('STORAGE_OBJECT_CHANGED');
    await file.close();file=undefined;await unlink(filename);await dir.fd.sync();removed++;
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   finally{await file?.close();}
   await c.query("UPDATE ac_storage_allocations SET state='deleted',updated_at=now() WHERE id=$1",[candidate.id]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'storage.deleted',$2)",[row.context_id,{allocationId:row.id,poolId:this.id,sha256:row.object_sha256}]);
  });return {removed};}finally{await dir.fd.close();}
 }
 async status(principal:string){
  const dir=await this.directory();try{return await this.ledger.tx(async c=>{
   await this.admin(c,principal);const pool=await this.locked(c,dir),fs=await statfs('/proc/self/fd/'+dir.fd.fd,{bigint:true});
   const rows=(await c.query("SELECT state,count(*)::int objects,sum(reserved_bytes)::text reserved FROM ac_storage_allocations WHERE pool_id=$1 GROUP BY state ORDER BY state",[this.id])).rows;
   return {poolId:this.id,revision:pool.revision,freeBytes:String(fs.bavail*fs.bsize),minFreeBytes:pool.min_free_bytes,budgetBytes:pool.budget_bytes,allocations:rows};
  });}finally{await dir.fd.close();}
 }
}
