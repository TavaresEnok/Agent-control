import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Id, Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';
export type EncryptionVariant='legacy'|'dataKey';
export const keyFingerprint=(key:Uint8Array)=>createHash('sha256').update(key).digest('hex');
export class ContextKeys{
 constructor(readonly ledger:Ledger){}
 async authorize(principal:string,contextId:string,version:number,variant:EncryptionVariant,fingerprint:string){
  const input=z.object({contextId:Id,version:z.number().int().positive(),variant:z.enum(['legacy','dataKey']),
   fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse({contextId,version,variant,fingerprint});
  await this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,input.contextId);
   if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const previous=(await c.query('SELECT COALESCE(max(version),0) version FROM ac_context_keys WHERE context_id=$1',[contextId])).rows[0].version;
   if(Number(previous)>=version)throw new Refusal('KEY_VERSION_CONFLICT');
   await c.query("UPDATE ac_context_keys SET state='revoked' WHERE context_id=$1 AND state='active'",[contextId]);
   await c.query('UPDATE ac_managers SET lease_until=clock_timestamp() WHERE context_id=$1',[contextId]);
   await c.query("INSERT INTO ac_context_keys(context_id,version,variant,fingerprint,state,authorized_by) VALUES($1,$2,$3,$4,'active',$5)",
    [contextId,version,variant,fingerprint,principal]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'context.key.authorized',$2)",[contextId,{version,variant}]);
  });
 }
 async revoke(principal:string,contextId:string,version:number){
  z.number().int().positive().parse(version);
  await this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,Id.parse(contextId));
   if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const changed=await c.query("UPDATE ac_context_keys SET state='revoked' WHERE context_id=$1 AND version=$2 AND state='active'",[contextId,version]);
   if(changed.rowCount)await c.query('UPDATE ac_managers SET lease_until=clock_timestamp() WHERE context_id=$1',[contextId]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'context.key.revoked',$2)",[contextId,{version}]);
  });
 }
 async validate(contextId:string,version:number,variant:EncryptionVariant,key:Uint8Array){
  if(key.byteLength!==32)throw new Refusal('INVALID_CONTEXT_KEY',403);
  const found=await this.ledger.pool.query("SELECT 1 FROM ac_context_keys WHERE context_id=$1 AND version=$2 AND variant=$3 AND fingerprint=$4 AND state='active'",
   [contextId,version,variant,keyFingerprint(key)]);
  if(!found.rowCount)throw new Refusal('CONTEXT_KEY_UNAUTHORIZED',403);
 }
}
