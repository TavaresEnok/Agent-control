import { z } from 'zod';
import type pg from 'pg';
import { digest, Id, Refusal } from './contracts.ts';
import type { Ledger } from './ledger.ts';
import { assertCurrentTemplatePolicy, Template, Templates, type TemplateSnapshot } from './templates.ts';

export const PROJECT_TEMPLATE_VIEW_LIMIT=100;
const lockSeed=57;
export const ProjectTemplateName=z.string().trim().min(1).max(80).refine(value=>/^[\p{L}\p{N}][\p{L}\p{N} ._()/-]*$/u.test(value),{message:'PROJECT_TEMPLATE_NAME_INVALID'});
export const ProjectTemplatePublish=z.object({
 templateId:Id,expectedRevision:z.number().int().nonnegative(),name:ProjectTemplateName,template:Template,digest:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const ProjectTemplateApply=z.object({
 templateId:Id,revision:z.number().int().positive(),expectedRevision:z.number().int().nonnegative(),expectedContextRevision:z.number().int().nonnegative(),
}).strict();
export type ProjectTemplateView={
 templateId:string;revision:number;headRevision:number;name:string;digest:string;snapshot:TemplateSnapshot;
};

function parsedSnapshot(raw:unknown){
 const parsed=Template.safeParse(raw);
 if(!parsed.success)throw new Refusal('PROJECT_TEMPLATE_SNAPSHOT_INVALID');
 return parsed.data;
}

/** One catalog identity is serialized across contexts. JSON keeps the text key free of NUL and unambiguous. */
export function projectTemplateLockKey(projectId:string,templateId:string){
 return JSON.stringify(['project-template',projectId,templateId]);
}
async function lockIdentity(c:pg.PoolClient,projectId:string,templateId:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,$2))',[projectTemplateLockKey(projectId,templateId),lockSeed]);
}

async function headRevision(c:pg.PoolClient,projectId:string,templateId:string){
 return Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_project_templates WHERE project_id=$1 AND template_id=$2',[projectId,templateId])).rows[0].revision);
}

export async function readProjectTemplates(c:pg.PoolClient,projectId:string){
 const rows=(await c.query(`SELECT template_id,revision,name,digest,snapshot,
  max(revision) OVER (PARTITION BY template_id) AS head_revision
  FROM ac_project_templates WHERE project_id=$1
  ORDER BY name,template_id,revision LIMIT $2`,[projectId,PROJECT_TEMPLATE_VIEW_LIMIT+1])).rows;
 const templates:ProjectTemplateView[]=[];
 for(const row of rows.slice(0,PROJECT_TEMPLATE_VIEW_LIMIT)){
  const snapshot=Template.safeParse(row.snapshot);
  if(!snapshot.success||digest(snapshot.data)!==row.digest)continue;
  const name=ProjectTemplateName.safeParse(row.name);
  if(!name.success)continue;
  templates.push({templateId:row.template_id,revision:Number(row.revision),headRevision:Number(row.head_revision),name:name.data,digest:row.digest,snapshot:snapshot.data});
 }
 return {templates,truncated:rows.length>PROJECT_TEMPLATE_VIEW_LIMIT};
}

export class ProjectTemplates{
 constructor(readonly ledger:Ledger,private readonly client?:pg.PoolClient){}
 private tx<T>(fn:(c:pg.PoolClient)=>Promise<T>){return this.client?fn(this.client):this.ledger.tx(fn);}
 private async owner(c:pg.PoolClient,principal:string,contextId:string){
  const context=await this.ledger.authorize(c,principal,Id.parse(contextId));
  if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
  return context;
 }
 async publish(principal:string,contextId:string,raw:z.input<typeof ProjectTemplatePublish>){
  const input=ProjectTemplatePublish.parse(raw);
  const template=parsedSnapshot(input.template);
  if(digest(template)!==input.digest)throw new Refusal('PROJECT_TEMPLATE_DIGEST_MISMATCH');
  return this.tx(async c=>{
   const context=await this.owner(c,principal,contextId);
   await assertCurrentTemplatePolicy(c,context.project_id,template);
   await lockIdentity(c,context.project_id,input.templateId);
   const latest=await headRevision(c,context.project_id,input.templateId);
   if(latest!==input.expectedRevision)throw new Refusal('PROJECT_TEMPLATE_REVISION_CONFLICT');
   const revision=latest+1;
   await c.query(`INSERT INTO ac_project_templates(project_id,template_id,revision,name,snapshot,digest,published_by)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[context.project_id,input.templateId,revision,input.name,template,input.digest,principal]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'project-template.published',$2)",[contextId,{templateId:input.templateId,revision,digest:input.digest,workflow:template.workflow}]);
   return {templateId:input.templateId,revision,digest:input.digest,name:input.name};
  });
 }
 async apply(principal:string,contextId:string,raw:z.input<typeof ProjectTemplateApply>){
  const input=ProjectTemplateApply.parse(raw);
  return this.tx(async c=>{
   const context=await this.owner(c,principal,contextId);
   await lockIdentity(c,context.project_id,input.templateId);
   const latest=await headRevision(c,context.project_id,input.templateId);
   if(latest!==input.expectedRevision)throw new Refusal('PROJECT_TEMPLATE_REVISION_CONFLICT');
   const saved=(await c.query('SELECT snapshot,digest FROM ac_project_templates WHERE project_id=$1 AND template_id=$2 AND revision=$3',[context.project_id,input.templateId,input.revision])).rows[0];
   if(!saved)throw new Refusal('PROJECT_TEMPLATE_NOT_FOUND');
   const template=parsedSnapshot(saved.snapshot);
   if(digest(template)!==saved.digest)throw new Refusal('PROJECT_TEMPLATE_DIGEST_MISMATCH');
   await assertCurrentTemplatePolicy(c,context.project_id,template);
   const frozen=await new Templates(this.ledger,c).freeze(principal,contextId,input.expectedContextRevision,template,{projectId:context.project_id,templateId:input.templateId,catalogRevision:input.revision});
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'project-template.applied',$2)",[contextId,{templateId:input.templateId,catalogRevision:input.revision,contextRevision:frozen.revision,digest:frozen.digest}]);
   return {templateId:input.templateId,catalogRevision:input.revision,contextRevision:frozen.revision,digest:frozen.digest};
  });
 }
}
