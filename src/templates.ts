import { z } from 'zod';
import type pg from 'pg';
import { Id,digest,Refusal } from './contracts.ts';
import type { Ledger } from './ledger.ts';
export const Template=z.discriminatedUnion('workflow',[
 z.object({workflow:z.literal('baseline-synthetic-v1')}).strict(),
 z.object({workflow:z.enum(['engineering-synthetic-v1','semantic-proposal-v1']),qualityRevision:z.number().int().positive(),
  targetRef:z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/)}).strict(),
 z.object({workflow:z.literal('engineering-native-v1'),qualityRevision:z.number().int().positive(),targetRef:z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/),writePaths:z.array(z.string().min(1).max(240).refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!/[\x00-\x1f*?\[\]{}]/.test(p)&&!p.split('/').some(s=>!s||['.','..','.git','.ai'].includes(s)))).min(1).max(64),execution:z.enum(['root','plan']).optional()}).strict(),
]);
export type TemplateSnapshot=z.infer<typeof Template>;
export type TemplateSource={projectId:string;templateId:string;catalogRevision:number};

/** Quality checks only. Callers insert the context row after this returns. */
export async function assertCurrentTemplatePolicy(c:pg.PoolClient,projectId:string,template:TemplateSnapshot){
 if((template.workflow==='engineering-synthetic-v1'||template.workflow==='semantic-proposal-v1'||template.workflow==='engineering-native-v1')&&!(await c.query('SELECT 1 FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[projectId,template.qualityRevision])).rowCount)
  throw new Refusal('QUALITY_POLICY_REQUIRED');
 if(template.workflow==='semantic-proposal-v1'||template.workflow==='engineering-native-v1'){
  await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE',[projectId]);
  const latest=(await c.query('SELECT max(revision) revision FROM ac_quality_policies WHERE project_id=$1',[projectId])).rows[0].revision;
  if(latest!==template.qualityRevision)throw new Refusal('QUALITY_POLICY_CONFLICT');
 }
}

export class Templates{
 constructor(readonly ledger:Ledger,private readonly client?:pg.PoolClient){}
 private tx<T>(fn:(c:pg.PoolClient)=>Promise<T>){return this.client?fn(this.client):this.ledger.tx(fn);}
 async publish(principal:string,contextId:string,expectedRevision:number,raw:z.input<typeof Template>){
  const frozen=await this.freeze(principal,contextId,expectedRevision,raw);
  return {revision:frozen.revision};
 }
 /** Copies an already parsed snapshot into the next context revision. No plan, account or profile write. */
 async freeze(principal:string,contextId:string,expectedRevision:number,raw:z.input<typeof Template>,source?:TemplateSource){
  const template=Template.parse(raw);z.number().int().nonnegative().parse(expectedRevision);
  if(source){Id.parse(source.projectId);Id.parse(source.templateId);z.number().int().positive().parse(source.catalogRevision);}
  return this.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,Id.parse(contextId));
   if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   if(source&&source.projectId!==context.project_id)throw new Refusal('PROJECT_TEMPLATE_NOT_FOUND');
   if(source){
    const origin=(await c.query('SELECT snapshot,digest FROM ac_project_templates WHERE project_id=$1 AND template_id=$2 AND revision=$3',[source.projectId,source.templateId,source.catalogRevision])).rows[0];
    if(!origin)throw new Refusal('PROJECT_TEMPLATE_NOT_FOUND');
    const originTemplate=Template.safeParse(origin.snapshot);
    if(!originTemplate.success||digest(originTemplate.data)!==origin.digest||digest(template)!==origin.digest)throw new Refusal('PROJECT_TEMPLATE_DIGEST_MISMATCH');
   }
   await assertCurrentTemplatePolicy(c,context.project_id,template);
   const latest=Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_context_templates WHERE context_id=$1',[contextId])).rows[0].revision);
   if(latest!==expectedRevision)throw new Refusal('TEMPLATE_REVISION_CONFLICT');
   const value=digest(template);
   await c.query(`INSERT INTO ac_context_templates(context_id,revision,snapshot,digest,published_by,source_project_id,source_template_id,source_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[contextId,latest+1,template,value,principal,source?.projectId??null,source?.templateId??null,source?.catalogRevision??null]);
   await c.query('UPDATE ac_contexts SET active_template_revision=$2 WHERE id=$1',[contextId,latest+1]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'template.published',$2)",[contextId,source
    ?{revision:latest+1,workflow:template.workflow,source:{templateId:source.templateId,catalogRevision:source.catalogRevision,digest:value}}
    :{revision:latest+1,workflow:template.workflow}]);
   return {revision:latest+1,digest:value};
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
   await assertCurrentTemplatePolicy(c,context.project_id,template);
   await c.query('UPDATE ac_contexts SET active_template_revision=$2 WHERE id=$1',[contextId,revision]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'template.assigned',$2)",[contextId,{revision}]);
   return {revision};
  });
 }
}
