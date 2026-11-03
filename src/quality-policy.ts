import { z } from 'zod';
import type pg from 'pg';
import { digest,Refusal } from './contracts.ts';
import type { Ledger } from './ledger.ts';
export const QualityPolicy=z.object({schemaVersion:z.literal(1),requiredReviews:z.number().int().min(1).max(3),
 allowLowRiskQaWaiver:z.boolean(),requireJudge:z.boolean().optional(),requireSpecialistBeforeImplementation:z.boolean().optional(),
 specialistVerifierDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),qaVerifierDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),verifierDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),requireHumanIntegration:z.boolean().default(true)}).strict();
export class QualityPolicies{
 constructor(readonly ledger:Ledger,private readonly client?:pg.PoolClient){}
 private tx<T>(fn:(c:pg.PoolClient)=>Promise<T>){return this.client?fn(this.client):this.ledger.tx(fn);}
 async publish(principal:string,projectId:string,expectedRevision:number,raw:z.input<typeof QualityPolicy>){
  const policy=QualityPolicy.parse(raw);z.number().int().nonnegative().parse(expectedRevision);
  if(!policy.verifierDigest)throw new Refusal('VERIFIER_VERSION_REQUIRED');
  if(policy.requireSpecialistBeforeImplementation&&!policy.specialistVerifierDigest)throw new Refusal('SPECIALIST_VERIFIER_VERSION_REQUIRED');
  return this.tx(async c=>{
   if(!(await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[projectId,principal])).rowCount)
    throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE',[projectId]);
   const current=Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_quality_policies WHERE project_id=$1',[projectId])).rows[0].revision);
   if(current!==expectedRevision)throw new Refusal('QUALITY_POLICY_CONFLICT');
   await c.query('INSERT INTO ac_quality_policies VALUES($1,$2,$3,$4)',[projectId,current+1,policy,digest(policy)]);
   return current+1;
  });
 }
}
