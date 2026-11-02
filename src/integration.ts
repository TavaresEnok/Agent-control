import { z } from 'zod';
import { Authority, Id, Refusal, digest } from './contracts.ts';
import { Ledger } from './ledger.ts';
import { Quality, type ArtifactRow } from './quality.ts';
import { GitArtifacts } from './git.ts';

/** Effects are admitted by PG. No scheduling, shell text or worker-chosen repository is accepted. */
export class Integrator{
 constructor(readonly ledger:Ledger,readonly quality:Quality,readonly git:GitArtifacts,
  private readonly projectId:string,private readonly targetRef:string){
  Id.parse(projectId);z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/).parse(targetRef);
 }
 async integrate(principal:string,integrationId:string,authority:Authority){
  const id=Id.parse(integrationId);
  const admitted=await this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);
   await this.ledger.fence(c,authority);
   const operation=(await c.query('SELECT * FROM ac_integration_intents WHERE id=$1 AND context_id=$2 FOR UPDATE',[id,authority.contextId])).rows[0];
   if(!operation)throw new Refusal('INTEGRATION_FORBIDDEN',403);
   const artifact=(await c.query<ArtifactRow>('SELECT * FROM ac_artifacts WHERE id=$1',[operation.artifact_id])).rows[0];
   if(artifact.project_id!==this.projectId||operation.target_ref!==this.targetRef)throw new Refusal('INTEGRATION_SCOPE_MISMATCH',403);
   // Idempotent replay returns the saved outcome without touching a later branch tip.
   if(operation.state==='integrated'||operation.state==='rejected')return {terminal:true as const,result:operation.receipt};
   if(operation.state!=='registered')throw new Refusal('INTEGRATION_UNCERTAIN');
   if(Number(operation.manager_epoch)!==authority.epoch)throw new Refusal('INTEGRATION_RECONCILIATION_REQUIRED');
   await this.quality.assertReady(c,artifact.id,authority);
   await c.query("UPDATE ac_integration_intents SET state='uncertain' WHERE id=$1",[id]);
   return {terminal:false as const,artifact};
  });
  if(admitted.terminal)return admitted.result;
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority);
   // The row lock spans two bounded Git helper calls; keep the lease valid for their full duration.
   await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '30 seconds' WHERE context_id=$1",[authority.contextId]);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[digest({projectId:this.projectId,targetRef:this.targetRef})]);
   const operation=(await c.query('SELECT * FROM ac_integration_intents WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(operation.state!=='uncertain'||Number(operation.manager_epoch)!==authority.epoch)throw new Refusal('INTEGRATION_RECONCILIATION_REQUIRED');
   const artifact=await this.quality.assertReady(c,admitted.artifact.id,authority);
   const observed=await this.git.identity(artifact.commit_id,artifact.base_id);
   if(observed.tree!==artifact.tree_id)throw new Refusal('ARTIFACT_TREE_MISMATCH');
   // Intention was committed before this effect. The manager row remains fenced through CAS.
   const receipt=await this.git.cas(artifact.commit_id,artifact.base_id,this.targetRef,id);
   if(receipt.status==='integrated'&&receipt.tree!==artifact.tree_id)throw new Refusal('INTEGRATION_RECEIPT_MISMATCH');
   await c.query('UPDATE ac_integration_intents SET state=$2,receipt=$3 WHERE id=$1',[id,receipt.status,receipt]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'integration.result',$2)",[authority.contextId,{integrationId:id,status:receipt.status}]);
   return receipt;
  });
 }
}
