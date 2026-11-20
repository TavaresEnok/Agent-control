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
   await this.ledger.assertIntentActive(c,authority.contextId,artifact.intent_id);
   if(operation.state!=='registered')throw new Refusal('INTEGRATION_UNCERTAIN');
   if(Number(operation.manager_epoch)!==authority.epoch)throw new Refusal('INTEGRATION_RECONCILIATION_REQUIRED');
   await this.quality.assertReady(c,artifact.id,authority);
   await c.query("UPDATE ac_integration_intents SET state='uncertain' WHERE id=$1",[id]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'integration.write_intended',$2)",[authority.contextId,{integrationId:id}]);
   return {terminal:false as const,artifact};
  });
  if(admitted.terminal)return admitted.result;
  // Until `attempted` is set no Git write was even requested, so a failure leaves the approved intention exactly as it was.
  let attempted=false;
  try{
   return await this.write(id,authority,admitted.artifact.id,()=>{attempted=true;});
  }catch(error){
   if(!attempted)await this.returnUnwritten(id,authority,error);
   throw error;
  }
 }
 /** The second transaction: everything that can refuse comes before the one effect, and `markAttempt` is the last line before it. */
 private async write(id:string,authority:Authority,artifactId:string,markAttempt:()=>void){
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority);
   // The row lock spans two bounded Git helper calls; keep the lease valid for their full duration.
   await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '30 seconds' WHERE context_id=$1",[authority.contextId]);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[digest({projectId:this.projectId,targetRef:this.targetRef})]);
   const operation=(await c.query('SELECT * FROM ac_integration_intents WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(operation.state!=='uncertain'||Number(operation.manager_epoch)!==authority.epoch)throw new Refusal('INTEGRATION_RECONCILIATION_REQUIRED');
   const artifact=await this.quality.assertReady(c,artifactId,authority);
   await this.quality.assertHumanApproval(c,artifact,this.targetRef);
   await this.ledger.assertIntentActive(c,authority.contextId,artifact.intent_id);
   const observed=await this.git.identity(artifact.commit_id,artifact.base_id);
   if(observed.tree!==artifact.tree_id)throw new Refusal('ARTIFACT_TREE_MISMATCH');
   // Intention was committed before this effect. The manager row remains fenced through CAS.
   // From here the write may happen even if the answer is lost, so a failure no longer proves anything.
   markAttempt();
   const receipt=await this.git.cas(artifact.commit_id,artifact.base_id,this.targetRef,id);
   if(receipt.status==='integrated'&&receipt.tree!==artifact.tree_id)throw new Refusal('INTEGRATION_RECEIPT_MISMATCH');
   await c.query('UPDATE ac_integration_intents SET state=$2,receipt=$3 WHERE id=$1',[id,receipt.status,receipt]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'integration.result',$2)",[authority.contextId,{integrationId:id,status:receipt.status}]);
   return receipt;
  });
 }
 /** The refusal came before any write was requested: the intention goes back to `registered` so a normal attempt can follow.
  * Done under the same fence, lock and epoch as the write would have had; a manager that lost its fence changes nothing. */
 private async returnUnwritten(id:string,authority:Authority,cause:unknown){
  try{
   await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[digest({projectId:this.projectId,targetRef:this.targetRef})]);
    const operation=(await c.query('SELECT * FROM ac_integration_intents WHERE id=$1 AND context_id=$2 FOR UPDATE',[id,authority.contextId])).rows[0];
    if(!operation||operation.state!=='uncertain'||Number(operation.manager_epoch)!==authority.epoch)return;
    await c.query("UPDATE ac_integration_intents SET state='registered' WHERE id=$1",[id]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'integration.returned_unwritten',$2)",
     [authority.contextId,{integrationId:id,code:cause instanceof Refusal?cause.code:'PREWRITE_FAILURE',gitWrite:false}]);
   });
  }catch{/* Fence lost or database unavailable: stays uncertain and reconcile decides from the observed reference. */}
 }
 /** Recover an uncertain CAS by observing its exact approved postcondition.
  * This method never writes Git. An unchanged/different target stays uncertain. */
 async reconcile(principal:string,integrationId:string,authority:Authority){
  const id=Id.parse(integrationId);
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '30 seconds' WHERE context_id=$1",[authority.contextId]);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[digest({projectId:this.projectId,targetRef:this.targetRef})]);
   const operation=(await c.query('SELECT * FROM ac_integration_intents WHERE id=$1 AND context_id=$2 FOR UPDATE',[id,authority.contextId])).rows[0];
   if(!operation)throw new Refusal('INTEGRATION_FORBIDDEN',403);
   const artifact=(await c.query<ArtifactRow>('SELECT * FROM ac_artifacts WHERE id=$1',[operation.artifact_id])).rows[0];
   if(!artifact||artifact.project_id!==this.projectId||operation.target_ref!==this.targetRef)throw new Refusal('INTEGRATION_SCOPE_MISMATCH',403);
   if(operation.state==='integrated'||operation.state==='rejected')return operation.receipt;
   if(operation.state!=='uncertain'||Number(operation.manager_epoch)>authority.epoch)return null;
   await this.quality.assertReady(c,artifact.id,authority);await this.quality.assertHumanApproval(c,artifact,this.targetRef);
   const observed=await this.git.observe(artifact.commit_id,artifact.base_id,this.targetRef);
   if(observed.tree!==artifact.tree_id)throw new Refusal('ARTIFACT_TREE_MISMATCH');
   if(observed.head===artifact.base_id){
    // The reference never left the base. Under this lock no write is in flight; the only way one could still land is an orphaned
    // helper from a controller that just died, so a fresh intention keeps waiting. After that, no write happened: back to registered.
    const recent=(await c.query(`SELECT 1 FROM ac_audit WHERE context_id=$1 AND kind='integration.write_intended' AND detail->>'integrationId'=$2
     AND created_at>clock_timestamp()-interval '30 seconds'`,[authority.contextId,id])).rowCount;
    if(recent)return null;
    await c.query("UPDATE ac_integration_intents SET state='registered',manager_epoch=$2 WHERE id=$1 AND state='uncertain'",[id,authority.epoch]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'integration.reconciled_unwritten',$2)",[authority.contextId,{integrationId:id,observedHead:observed.head,gitWrite:false}]);
    return null;
   }
   if(observed.head!==artifact.commit_id){
    // Someone else moved the reference. Without proof that the candidate is part of its history this is neither integrated nor
    // safely retryable; nothing is written, and the divergence is recorded once for the operator.
    const seen=(await c.query(`SELECT 1 FROM ac_audit WHERE context_id=$1 AND kind='integration.reconcile_diverged' AND detail->>'integrationId'=$2 AND detail->>'observedHead'=$3`,
     [authority.contextId,id,observed.head])).rowCount;
    if(!seen)await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'integration.reconcile_diverged',$2)",[authority.contextId,{integrationId:id,observedHead:observed.head,base:artifact.base_id,candidate:artifact.commit_id,gitWrite:false}]);
    return null;
   }
   const {head,...identity}=observed;
   const receipt={...identity,status:'integrated',operationId:id,reconciliation:{kind:'observed-approved-target',observedHead:head}};
   await c.query("UPDATE ac_integration_intents SET state='integrated',receipt=$2 WHERE id=$1",[id,receipt]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'integration.reconciled',$2)",[authority.contextId,{integrationId:id,commit:artifact.commit_id,gitWrite:false}]);
   return receipt;
  });
 }
}
