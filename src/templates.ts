import { z } from 'zod';
import type pg from 'pg';
import { Id,digest,Refusal } from './contracts.ts';
import type { Ledger } from './ledger.ts';
export const Template=z.discriminatedUnion('workflow',[
 z.object({workflow:z.literal('baseline-synthetic-v1')}).strict(),
 z.object({workflow:z.enum(['engineering-synthetic-v1','semantic-proposal-v1']),qualityRevision:z.number().int().positive(),
  targetRef:z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/)}).strict(),
]);
export class Templates{
 constructor(readonly ledger:Ledger,private readonly client?:pg.PoolClient){}
 private tx<T>(fn:(c:pg.PoolClient)=>Promise<T>){return this.client?fn(this.client):this.ledger.tx(fn);}
 async publish(principal:string,contextId:string,expectedRevision:number,raw:z.input<typeof Template>){
  const template=Template.parse(raw);z.number().int().nonnegative().parse(expectedRevision);
  return this.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,Id.parse(contextId));
   if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const latest=Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_context_templates WHERE context_id=$1',[contextId])).rows[0].revision);
   if(latest!==expectedRevision)throw new Refusal('TEMPLATE_REVISION_CONFLICT');
   if((template.workflow==='engineering-synthetic-v1'||template.workflow==='semantic-proposal-v1')&&!(await c.query('SELECT 1 FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[context.project_id,template.qualityRevision])).rowCount)
    throw new Refusal('QUALITY_POLICY_REQUIRED');
   if(template.workflow==='semantic-proposal-v1'){
    await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE',[context.project_id]);
    const latest=(await c.query('SELECT max(revision) revision FROM ac_quality_policies WHERE project_id=$1',[context.project_id])).rows[0].revision;
    if(latest!==template.qualityRevision)throw new Refusal('QUALITY_POLICY_CONFLICT');
   }
   await c.query('INSERT INTO ac_context_templates(context_id,revision,snapshot,digest,published_by) VALUES($1,$2,$3,$4,$5)',
    [contextId,latest+1,template,digest(template),principal]);
   await c.query('UPDATE ac_contexts SET active_template_revision=$2 WHERE id=$1',[contextId,latest+1]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'template.published',$2)",[contextId,{revision:latest+1,workflow:template.workflow}]);
   return {revision:latest+1};
  });
 }
 async assign(principal:string,contextId:string,revision:number){
  z.number().int().positive().parse(revision);
  return this.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,Id.parse(contextId));
   if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const saved=(await c.query('SELECT snapshot,digest FROM ac_context_templates WHERE context_id=$1 AND revision=$2',[contextId,revision])).rows[0];
   if(!saved)throw new Refusal('TEMPLATE_NOT_FOUND');const template=Template.parse(saved.snapshot);
   if(digest(template)!==saved.digest)throw new Refusal('TEMPLATE_DIGEST_MISMATCH');
   if(template.workflow==='semantic-proposal-v1'){
    await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE',[context.project_id]);
    const latest=(await c.query('SELECT max(revision) revision FROM ac_quality_policies WHERE project_id=$1',[context.project_id])).rows[0].revision;
    if(latest!==template.qualityRevision)throw new Refusal('QUALITY_POLICY_CONFLICT');
   }
   await c.query('UPDATE ac_contexts SET active_template_revision=$2 WHERE id=$1',[contextId,revision]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'template.assigned',$2)",[contextId,{revision}]);
   return {revision};
  });
 }
}
