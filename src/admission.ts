import { z } from 'zod';
import { Ledger } from './ledger.ts';
import { Refusal } from './contracts.ts';
import type pg from 'pg';
export class Admission{
 constructor(readonly ledger:Ledger,private readonly client?:pg.PoolClient){}
 async set(principal:string,input:{enabled:boolean;expectedRevision:number;reason:string}){
  const value=z.object({enabled:z.boolean(),expectedRevision:z.number().int().positive(),reason:z.string().min(1).max(200)}).strict().parse(input);
  const effect=async(c:pg.PoolClient)=>{
   if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
   const state=(await c.query('SELECT * FROM ac_admission_control WHERE id=1 FOR UPDATE')).rows[0];
   if(state.revision!==value.expectedRevision)throw new Refusal('ADMISSION_REVISION_CONFLICT');
   if(value.enabled){
    const blockers=(await c.query(`SELECT
      (SELECT count(*) FROM ac_operations WHERE state IN ('running','uncertain'))+
      (SELECT count(*) FROM ac_stage_operations WHERE state IN ('running','uncertain'))+
      (SELECT count(*) FROM ac_sandbox_jobs WHERE state IN ('running','uncertain'))+
      (SELECT count(*) FROM ac_capacity_grants WHERE state<>'released')+
      (SELECT count(*) FROM ac_remote_operations WHERE state IN ('running','uncertain'))+
      (SELECT count(*) FROM ac_integration_intents WHERE state='uncertain') AS total`)).rows[0];
    if(Number(blockers.total)>0)throw new Refusal('RECONCILIATION_REQUIRED');
   }
   await c.query('UPDATE ac_admission_control SET enabled=$1,revision=revision+1,reason=$2,updated_at=now() WHERE id=1',[value.enabled,value.reason]);
   return {enabled:value.enabled,revision:state.revision+1};
  };
  return this.client?effect(this.client):this.ledger.tx(effect);
 }
}
