import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {canonical,digest,Id,Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {CapacityPolicy} from './capacity.ts';
import {QualityPolicy} from './quality-policy.ts';
import {ProjectEnvironmentConfig} from './project-environments.ts';
import {Template} from './templates.ts';

const MAX_ROWS=10000,MAX_BYTES=16*1024*1024;
const ref=(value:unknown)=>({rebindNeeded:true as const,id:digest(value)});
const envelope=z.object({schemaVersion:z.literal(1),kind:z.literal('agent_control_config_encrypted'),algorithm:z.literal('aes-256-gcm'),nonce:z.string().regex(/^[a-f0-9]{24}$/),tag:z.string().regex(/^[a-f0-9]{32}$/),ciphertext:z.string().regex(/^[a-f0-9]*$/).max(MAX_BYTES*2)}).strict();
/** Read-only projection. Never queries credentials, endpoints, private key files, or filesystem identity. */
export async function collectConfiguration(ledger:Ledger,principal:string,projectId:string){
 Id.parse(projectId);
 return ledger.tx(async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='5000ms'");
  if(!(await c.query("SELECT 1 FROM ac_control_admins a JOIN ac_memberships m ON m.principal_id=a.principal_id WHERE a.principal_id=$1 AND m.project_id=$2 AND m.role='owner'",[principal,projectId])).rowCount)throw new Refusal('CONFIG_EXPORT_FORBIDDEN',403);
  const rows=async(sql:string)=>{const r=(await c.query(sql,[projectId,MAX_ROWS+1])).rows;if(r.length>MAX_ROWS)throw new Refusal('CONFIG_EXPORT_TOO_LARGE');return r;};
  const project=(await c.query('SELECT id,label FROM ac_projects WHERE id=$1',[projectId])).rows[0];if(!project)throw new Refusal('CONFIG_EXPORT_FORBIDDEN',403);
  const env=await rows('SELECT revision,snapshot,digest FROM ac_project_environment_revisions WHERE project_id=$1 ORDER BY revision LIMIT $2');
  const templates=await rows('SELECT template_id,revision,snapshot,digest FROM ac_project_templates WHERE project_id=$1 ORDER BY template_id,revision LIMIT $2');
  const capacity=await rows('SELECT revision,snapshot,digest FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision LIMIT $2');
  const quality=await rows('SELECT revision,snapshot,digest FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision LIMIT $2');
  const profiles=await rows('SELECT p.id,p.account_id,p.model,p.effort,p.role,p.enabled FROM ac_profiles p JOIN ac_account_access a ON a.account_id=p.account_id WHERE a.project_id=$1 ORDER BY p.id LIMIT $2');
  const verify=(r:any)=>{if(digest(r.snapshot)!==r.digest)throw new Refusal('CONFIG_EXPORT_CORRUPT');};
  const dto={schemaVersion:1 as const,kind:'agent_control_config_projection' as const,restorable:false as const,
   project:{id:project.id,label:ref(project.label),repository:ref(['projectRepository',project.id])},
   environments:env.map(r=>{verify(r);const x=ProjectEnvironmentConfig.parse(r.snapshot);return {revision:r.revision,sourceBranch:ref(x.sourceBranch),environments:x.environments.map(e=>({id:ref(e.id),label:ref(e.label),targetRef:ref(e.targetRef),authorizedDirectories:e.authorizedDirectories.map(ref),destinations:e.destinations.map(d=>({id:ref(d.id),label:ref(d.label),kind:d.kind,...(d.kind==='remote'?{host:ref(d.hostId),allowedPurposes:d.allowedPurposes}:{})}))}))};}),
   templates:templates.map(r=>{verify(r);const t=Template.parse(r.snapshot);return {id:r.template_id,revision:r.revision,workflow:t.workflow,...('qualityRevision' in t?{qualityRevision:t.qualityRevision,targetRef:ref(t.targetRef)}:{}),...('writePaths' in t?{writePaths:t.writePaths.map(ref),execution:t.execution??null}:{})};}),
   capacityPolicies:capacity.map(r=>{verify(r);return {revision:r.revision,policy:CapacityPolicy.parse(r.snapshot)};}),
   qualityPolicies:quality.map(r=>{verify(r);const p=QualityPolicy.parse(r.snapshot);return {revision:r.revision,policy:{...p,protectedGatePaths:p.protectedGatePaths.map(ref)}};}),
   profiles:profiles.map(p=>({id:p.id,account:ref(p.account_id),model:ref(p.model),effort:p.effort,role:p.role,enabled:p.enabled})),
   installationBindings:[ref(['database',projectId]),ref(['credentials',projectId]),ref(['privateDirectories',projectId]),ref(['endpoints',projectId])]};
  if(Buffer.byteLength(canonical(dto))>MAX_BYTES)throw new Refusal('CONFIG_EXPORT_TOO_LARGE');return dto;
 });
}
/** Key supplied independently by caller; neither key nor source credentials enter the envelope. */
export function sealConfiguration(dto:Awaited<ReturnType<typeof collectConfiguration>>,key:Uint8Array){
 if(key.length!==32)throw new Refusal('CONFIG_EXPORT_INVALID_KEY');const plaintext=Buffer.from(canonical(dto));if(plaintext.length>MAX_BYTES)throw new Refusal('CONFIG_EXPORT_TOO_LARGE');
 try{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('agent-control-config-v1'));const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);return envelope.parse({schemaVersion:1,kind:'agent_control_config_encrypted',algorithm:'aes-256-gcm',nonce:nonce.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')});}finally{plaintext.fill(0);}
}
/** Inspection only, never restores or activates settings. */
export function inspectConfiguration(raw:unknown,key:Uint8Array){
 if(key.length!==32)throw new Refusal('CONFIG_EXPORT_INVALID_KEY');const e=envelope.parse(raw);try{const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(e.nonce,'hex'));cipher.setAAD(Buffer.from('agent-control-config-v1'));cipher.setAuthTag(Buffer.from(e.tag,'hex'));const bytes=Buffer.concat([cipher.update(Buffer.from(e.ciphertext,'hex')),cipher.final()]);try{return JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}}catch{throw new Refusal('CONFIG_EXPORT_INVALID_ARTIFACT');}
}
