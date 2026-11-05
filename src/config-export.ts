import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {canonical,digest,Id,Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {CapacityPolicy} from './capacity.ts';
import {QualityPolicy} from './quality-policy.ts';
import {ProjectEnvironmentConfig} from './project-environments.ts';
import {Template} from './templates.ts';
import {Installation,type Installation as InstallationType} from './installation.ts';

const MAX_ROWS=10000,MAX_BYTES=16*1024*1024;
const ref=(kind:string,id:string)=>({rebindNeeded:true as const,kind,id});
const Binding=z.object({rebindNeeded:z.literal(true),kind:z.enum(['private_path','credential','endpoint','environment','principal','repository']),id:z.string().min(1).max(300)}).strict();
const InstallationProjection=z.object({schemaVersion:z.literal(1),mode:z.literal('administration-only'),databaseUrl:Binding,projectRoots:z.array(z.json()),dataDirectory:Binding,project:z.json(),projects:z.array(z.json()),contextVault:z.json().optional(),accountHomesDirectory:Binding.optional(),workflowRuntime:z.json().optional(),installationAuthority:z.json().optional(),remoteReturn:z.json().optional(),remoteDevelopment:z.json().optional(),nativeBootstrap:z.json().optional(),codexQuota:z.json().optional(),managerTransport:z.json().optional(),http:z.json(),happier:z.json(),sessionMaxAgeSeconds:z.number().int(),repositoryLocations:z.array(z.json())}).strict();
const ProjectConfig=z.object({id:Id,label:z.string(),repository:Binding}).strict();
const ProjectPayload=z.object({project:ProjectConfig,
 environments:z.array(z.object({revision:z.number().int().positive(),head:z.boolean(),config:ProjectEnvironmentConfig}).strict()),
 templates:z.array(z.object({id:Id,revision:z.number().int().positive(),name:z.string(),snapshot:Template}).strict()),
 capacityPolicies:z.array(z.object({revision:z.number().int().positive(),policy:CapacityPolicy}).strict()),
 qualityPolicies:z.array(z.object({revision:z.number().int().positive(),policy:QualityPolicy}).strict()),
 profiles:z.array(z.object({id:Id,accountId:Id,model:z.string(),effort:z.enum(['low','medium','high']),role:z.enum(['manager','programmer','reviewer','qa','specialist','judge']),enabled:z.boolean()}).strict()),
 accounts:z.array(z.object({id:Id,provider:z.string(),label:z.string(),mode:z.string(),eligibility:z.string(),enabled:z.boolean(),maxConcurrent:z.number().int(),identity:Binding}).strict()),
 models:z.array(z.object({provider:z.string(),model:z.string(),efforts:z.array(z.string()),roles:z.array(z.string())}).strict())
}).strict();
export const ConfigDto=ProjectPayload.extend({schemaVersion:z.literal(2),kind:z.literal('agent_control_config_projection'),restorable:z.literal(false),installation:InstallationProjection,additionalProjects:z.array(ProjectPayload)}).strict();
// Installation is parsed through its strict source schema first. Sensitive source
// fields are replaced by typed logical bindings, never by their values or hashes.
function installationProjection(config:InstallationType){
 const source=Installation.parse(config);const sensitive=/^(databaseUrl|token|tokenFile|masterFile|signingKeyFile|verifierKeyFile|credential|credentials|workerEnv|toolsEnv|environment|argv|device|inode|uid)$/i;
 const endpoints=/^(upstreamOrigin|webOrigin|publicServerOrigin|publicOrigin|allowedHosts)$/i;
 function visit(value:unknown,path:string,key:string):unknown{
  if(sensitive.test(key))return ref(['workerenv','toolsenv','environment','argv'].includes(key.toLowerCase())?'environment':'credential',path);
  if(endpoints.test(key))return ref('endpoint',path);
  if(key==='owner'||key==='principal')return ref('principal',path);
  if(typeof value==='string'&&(value.startsWith('/')||key.toLowerCase().includes('home')))return ref(key==='repo'?'repository':'private_path',path);
  if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string')return value;
  if(Array.isArray(value))return value.map((v,i)=>visit(v,`${path}.${i}` ,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,`${path}.${k}`,k)]));
  throw new Refusal('CONFIG_EXPORT_UNSUPPORTED');
 }
 const projected=visit(source,'installation','installation') as Record<string,unknown>;projected.repositoryLocations=[source.project,...source.projects].map(project=>{const root=source.projectRoots.find(r=>project.repo.startsWith(r.path+'/'));return {projectId:project.id,rootId:root?.id??null,relativePath:root?project.repo.slice(root.path.length+1):null,anchor:ref('repository',`project.${project.id}.repository`)};});return projected;
}
// Fail closed on apparent secret-bearing or host-bound text in fields expected to
// carry portable semantics. Unrecognized arbitrary text is never silently altered.
function checkInstallation(value:unknown){
 const root=InstallationProjection.parse(value);const privateKeys=/^(databaseUrl|token|tokenFile|masterFile|signingKeyFile|verifierKeyFile|credential|credentials|workerEnv|toolsEnv|environment|argv|device|inode|uid|upstreamOrigin|webOrigin|publicServerOrigin|publicOrigin|allowedHosts|owner|principal|repo|dataDirectory|accountHomesDirectory|path|directory|hostRoot|accountRoot|tmpfsRoot|home)$/i;
 const visit=(v:unknown,key:string)=>{if(privateKeys.test(key)){if(Binding.safeParse(v).success)return;throw new Refusal('CONFIG_EXPORT_INVALID_PROJECTION');}
  if(typeof v==='string'&&v.startsWith('/'))throw new Refusal('CONFIG_EXPORT_INVALID_PROJECTION');if(Array.isArray(v)){for(const x of v)visit(x,'');}else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))visit(x,k);};visit(root,'installation');
}
function checkProjectSet(dto:z.infer<typeof ConfigDto>){const p=z.object({id:Id}).passthrough();const configured=[p.parse(dto.installation.project).id,...dto.installation.projects.map(x=>p.parse(x).id)];const actual=[dto.project.id,...dto.additionalProjects.map(x=>x.project.id)];if(new Set(configured).size!==configured.length||new Set(actual).size!==actual.length||configured.length!==actual.length||configured.some(id=>!actual.includes(id)))throw new Refusal('CONFIG_EXPORT_PROJECT_SET_INVALID');}
function checkPortable(value:unknown){
 const walk=(v:unknown)=>{if(typeof v==='string'){if(v.startsWith('/'))throw new Refusal('CONFIG_EXPORT_UNSAFE_SEMANTIC_TEXT');if(/(?:https?:\/\/[^\s/]+@|[?&](?:token|password|key|secret)=|\bHOME=|-----BEGIN |\b(?:sk|ghp|github_pat|xox[baprs])-|bearer\s+|(?:password|secret|token|credential)\s*[=:]|(?:^|[\s=])\/(?:home|root|Users)\/)/i.test(v))throw new Refusal('CONFIG_EXPORT_UNSAFE_SEMANTIC_TEXT');return;}if(Array.isArray(v)){for(const x of v)walk(x);return;}if(v&&typeof v==='object')for(const x of Object.values(v))walk(x);};walk(value);
}
const envelope=z.object({schemaVersion:z.literal(2),kind:z.literal('agent_control_config_encrypted'),algorithm:z.literal('aes-256-gcm'),nonce:z.string().regex(/^[a-f0-9]{24}$/),tag:z.string().regex(/^[a-f0-9]{32}$/),ciphertext:z.string().regex(/^[a-f0-9]*$/).max(MAX_BYTES*2)}).strict();
/** Read-only projection. Never queries credentials, endpoints, private key files, or filesystem identity. */
export async function collectConfiguration(ledger:Ledger,principal:string,projectId:string,config:InstallationType){
 Id.parse(projectId);const installation=installationProjection(config);
 return ledger.tx(async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='5000ms'");
  if(!(await c.query("SELECT 1 FROM ac_control_admins a JOIN ac_memberships m ON m.principal_id=a.principal_id WHERE a.principal_id=$1 AND m.project_id=$2 AND m.role='owner'",[principal,projectId])).rowCount)throw new Refusal('CONFIG_EXPORT_FORBIDDEN',403);
  const projectIds=[config.project,...config.projects].map(p=>p.id);if(!projectIds.includes(projectId))throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
  if(Number((await c.query("SELECT count(*) n FROM ac_memberships WHERE principal_id=$1 AND role='owner' AND project_id=ANY($2::uuid[])",[principal,projectIds])).rows[0].n)!==projectIds.length)throw new Refusal('CONFIG_EXPORT_FORBIDDEN',403);
  let totalRows=0;const rows=async(sql:string,id:string)=>{const r=(await c.query(sql,[id,MAX_ROWS+1])).rows;totalRows+=r.length;if(totalRows>MAX_ROWS)throw new Refusal('CONFIG_EXPORT_TOO_LARGE');return r;};
  const collectProject=async(id:string)=>{
  const project=(await c.query('SELECT id,label FROM ac_projects WHERE id=$1',[id])).rows[0];if(!project)throw new Refusal('CONFIG_EXPORT_FORBIDDEN',403);
  const env=await rows('SELECT r.revision,r.snapshot,r.digest,(h.revision=r.revision) AS head FROM ac_project_environment_revisions r LEFT JOIN ac_project_environment_heads h USING(project_id) WHERE r.project_id=$1 ORDER BY r.revision LIMIT $2',id);
  const templates=await rows('SELECT template_id,revision,name,snapshot,digest FROM ac_project_templates WHERE project_id=$1 ORDER BY template_id,revision LIMIT $2',id);
  const capacity=await rows('SELECT revision,snapshot,digest FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision LIMIT $2',id);
  const quality=await rows('SELECT revision,snapshot,digest FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision LIMIT $2',id);
  const profiles=await rows('SELECT p.id,p.account_id,p.model,p.effort,p.role,p.enabled FROM ac_profiles p JOIN ac_account_access a ON a.account_id=p.account_id WHERE a.project_id=$1 ORDER BY p.id LIMIT $2',id);
  const accounts=await rows('SELECT a.id,a.provider,a.label,a.mode,a.eligibility,a.enabled,a.max_concurrent FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1 ORDER BY a.id LIMIT $2',id);
  const models=await rows('SELECT DISTINCT c.provider,c.model,c.efforts,c.roles FROM ac_model_catalog c JOIN ac_accounts a ON a.provider=c.provider JOIN ac_account_access x ON x.account_id=a.id JOIN ac_profiles p ON p.account_id=a.id AND p.model=c.model WHERE x.project_id=$1 ORDER BY c.provider,c.model LIMIT $2',id);
  const verify=(r:any)=>{if(digest(r.snapshot)!==r.digest)throw new Refusal('CONFIG_EXPORT_CORRUPT');};
  return {project:{id:project.id,label:project.label,repository:ref('repository',`project.${project.id}.repository`)},
   environments:env.map(r=>{verify(r);return {revision:r.revision,head:!!r.head,config:ProjectEnvironmentConfig.parse(r.snapshot)};}),
   templates:templates.map(r=>{verify(r);return {id:r.template_id,revision:r.revision,name:r.name,snapshot:Template.parse(r.snapshot)};}),
   capacityPolicies:capacity.map(r=>{verify(r);return {revision:r.revision,policy:CapacityPolicy.parse(r.snapshot)};}),
   qualityPolicies:quality.map(r=>{verify(r);return {revision:r.revision,policy:QualityPolicy.parse(r.snapshot)};}),
   profiles:profiles.map(p=>({id:p.id,accountId:p.account_id,model:p.model,effort:p.effort,role:p.role,enabled:p.enabled})),
   accounts:accounts.map(a=>({id:a.id,provider:a.provider,label:a.label,mode:a.mode,eligibility:a.eligibility,enabled:a.enabled,maxConcurrent:a.max_concurrent,identity:ref('credential',`account.${a.id}.identity`)})),
   models:models.map(m=>({provider:m.provider,model:m.model,efforts:m.efforts,roles:m.roles}))};
  };
  const main=await collectProject(projectId),additionalProjects=[];for(const id of projectIds)if(id!==projectId)additionalProjects.push(await collectProject(id));
  const dto={schemaVersion:2 as const,kind:'agent_control_config_projection' as const,restorable:false as const,installation,...main,additionalProjects};
  checkPortable(dto);checkInstallation(dto.installation);checkProjectSet(ConfigDto.parse(dto));
  if(Buffer.byteLength(canonical(dto))>MAX_BYTES)throw new Refusal('CONFIG_EXPORT_TOO_LARGE');return dto;
 });
}
/** Key supplied independently by caller; neither key nor source credentials enter the envelope. */
export function sealConfiguration(dto:Awaited<ReturnType<typeof collectConfiguration>>,key:Uint8Array){
 if(key.length!==32)throw new Refusal('CONFIG_EXPORT_INVALID_KEY');checkPortable(dto);checkInstallation(dto.installation);checkProjectSet(ConfigDto.parse(dto));const plaintext=Buffer.from(canonical(ConfigDto.parse(dto)));if(plaintext.length>MAX_BYTES)throw new Refusal('CONFIG_EXPORT_TOO_LARGE');
 try{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('agent-control-config-v2'));const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);return envelope.parse({schemaVersion:2,kind:'agent_control_config_encrypted',algorithm:'aes-256-gcm',nonce:nonce.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')});}finally{plaintext.fill(0);}
}
/** Inspection only, never restores or activates settings. */
export function inspectConfiguration(raw:unknown,key:Uint8Array){
 if(key.length!==32)throw new Refusal('CONFIG_EXPORT_INVALID_KEY');const e=envelope.parse(raw);try{const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(e.nonce,'hex'));cipher.setAAD(Buffer.from('agent-control-config-v2'));cipher.setAuthTag(Buffer.from(e.tag,'hex'));const bytes=Buffer.concat([cipher.update(Buffer.from(e.ciphertext,'hex')),cipher.final()]);try{const dto=ConfigDto.parse(JSON.parse(bytes.toString('utf8')));checkPortable(dto);checkInstallation(dto.installation);checkProjectSet(dto);return dto;}finally{bytes.fill(0);}}catch{throw new Refusal('CONFIG_EXPORT_INVALID_ARTIFACT');}
}

/** Private, exclusive creation. Key file is supplied separately and never embedded. */
export async function writeConfiguration(ledger:Ledger,principal:string,projectId:string,outputPath:string,keyPath:string,repositories:readonly string[],config:InstallationType){
 const {constants}=await import('node:fs');const {open,realpath,stat,unlink}=await import('node:fs/promises');const {dirname,isAbsolute,resolve,sep}=await import('node:path');const {readPrivateFile}=await import('./installation.ts');
 const safe=async(path:string,existing:boolean)=>{if(!isAbsolute(path)||resolve(path)!==path||repositories.some(repo=>path===repo||path.startsWith(repo+sep)))throw new Refusal('UNSAFE_PRIVATE_FILE',403);const check=existing?path:dirname(path);if(await realpath(check)!==check)throw new Refusal('UNSAFE_PRIVATE_FILE',403);};
 await safe(keyPath,true);await safe(outputPath,false);if(keyPath===outputPath)throw new Refusal('CONFIG_EXPORT_KEY_CUSTODY',403);
 for(const directory of [dirname(outputPath),dirname(keyPath)]){const parent=await stat(directory);if(await realpath(directory)!==directory||!parent.isDirectory()||(parent.mode&0o077)!==0||parent.uid!==process.getuid?.())throw new Refusal('UNSAFE_PRIVATE_DIRECTORY',403);}
 const key=await readPrivateFile(keyPath,32,{canonical:true});try{if(key.length!==32)throw new Refusal('CONFIG_EXPORT_INVALID_KEY');const dto=await collectConfiguration(ledger,principal,projectId,config);const serialized=Buffer.from(canonical(sealConfiguration(dto,key)));let file;let complete=false;
  try{file=await open(outputPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await file.writeFile(serialized);await file.sync();complete=true;}finally{await file?.close();if(file&&!complete)await unlink(outputPath).catch(()=>{});serialized.fill(0);}
  return {state:'exported' as const,projectId,restorable:false as const};
 }finally{key.fill(0);}
}
export async function readConfiguration(artifactPath:string,keyPath:string){
 const {readPrivateFile}=await import('./installation.ts');if(artifactPath===keyPath)throw new Refusal('CONFIG_EXPORT_KEY_CUSTODY',403);
 const key=await readPrivateFile(keyPath,32,{canonical:true});let bytes:Buffer|undefined;try{bytes=await readPrivateFile(artifactPath,MAX_BYTES*2+4096,{canonical:true});return inspectConfiguration(JSON.parse(bytes.toString('utf8')),key);}finally{key.fill(0);bytes?.fill(0);}
}
