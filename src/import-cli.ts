import {realpath} from 'node:fs/promises';
import {isAbsolute,resolve,sep} from 'node:path';
import {z} from 'zod';
import {ImportBundle,IsolatedImport} from './import.ts';
import {HappierImportTransport} from './happier-import.ts';
import {loadHappier,type HappierBoundary} from './happier.ts';
import {keyFingerprint} from './context-keys.ts';
import {Id,Refusal} from './contracts.ts';
import {readPrivateFile,type Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';

const SessionKey=z.object({sessionId:z.string().min(1).max(200),variant:z.enum(['legacy','dataKey']),keyFile:z.string().min(1)}).strict();
const Descriptor=z.discriminatedUnion('action',[
 z.object({action:z.literal('stage'),bundleFile:z.string().min(1),tokenFile:z.string().min(1),sessionKeys:z.array(SessionKey).min(1).max(100)}).strict(),
 z.object({action:z.literal('deliver'),importId:Id,tokenFile:z.string().min(1),sessionKeys:z.array(SessionKey).min(1).max(100)}).strict(),
 z.object({action:z.literal('archive'),importId:Id}).strict(),
]);
/** Explicit, local migration command. Never invoked by serve, a worker or a timer.
 * No source Paseo database is opened and no imported plan is made runnable. */
export async function executeImport(command:'import-stage'|'import-deliver'|'import-archive',config:Installation,ledger:Ledger,descriptorPath:string){
 const repositories=[...new Set([config.project.repo,...config.projects.map(p=>p.repo),
  ...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))])];
 const outside=async(path:string,max:number)=>{
  if(!isAbsolute(path)||resolve(path)!==path||await realpath(path)!==path||repositories.some(repo=>path===repo||path.startsWith(repo+sep)))
   throw new Refusal('UNSAFE_PRIVATE_FILE',403);
  return readPrivateFile(path,max);
 };
 const bytes=await outside(descriptorPath,65536),keys=new Map<string,{variant:'legacy'|'dataKey';key:Buffer}>();let tokenBytes:Buffer|undefined,bundleBytes:Buffer|undefined;
 try{
  const descriptor=Descriptor.parse(JSON.parse(bytes.toString('utf8')));
  if(command!==`import-${descriptor.action}`)throw new Refusal('IMPORT_COMMAND_MISMATCH',400);
  // Archiving uses only the local journal and refuses any imported context in use.
  if(descriptor.action==='archive'){
   const row=(await ledger.pool.query('SELECT project_id FROM ac_import_batches WHERE id=$1',[descriptor.importId])).rows[0];
   if(row?.project_id!==config.project.id)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const unavailable=async()=>{throw new Refusal('IMPORT_TRANSPORT_DISABLED');};
   return new IsolatedImport(ledger,{verifySession:unavailable,verifySessionKey:unavailable,verifyCiphertext:unavailable,deliver:unavailable}).archive(config.project.owner,descriptor.importId);
  }
  if(new Set(descriptor.sessionKeys.map(key=>key.sessionId)).size!==descriptor.sessionKeys.length)throw new Refusal('IMPORT_DUPLICATE_SESSION_KEY',400);
  for(const item of descriptor.sessionKeys){
   const key=await outside(item.keyFile,32);
   if(key.length!==32){key.fill(0);throw new Refusal('INVALID_CONTEXT_KEY',400);}
   keys.set(item.sessionId,{variant:item.variant,key});
  }
  tokenBytes=await outside(descriptor.tokenFile,16384);
  const token=tokenBytes.toString('utf8').trim();
  if(!token||/[\s\x00-\x1f\x7f]/.test(token))throw new Refusal('IMPORT_TOKEN_INVALID',400);
  const profile=await fetch(new URL('/v1/account/profile',config.happier.upstreamOrigin),{
   headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!profile.ok||z.object({id:z.string()}).passthrough().parse(await profile.json()).id!==config.project.owner)
   throw new Refusal('IMPORT_PRINCIPAL_MISMATCH',403);
  const boundary:HappierBoundary=await loadHappier();
  const transport=new HappierImportTransport(config.happier.upstreamOrigin,async principal=>{
   if(principal!==config.project.owner)throw new Refusal('IMPORT_PRINCIPAL_MISMATCH',403);return token;
  },async(principal,sessionId,variant,fingerprint)=>{
   const value=keys.get(sessionId);return principal===config.project.owner&&!!value&&value.variant===variant&&keyFingerprint(value.key)===fingerprint;
  },async(principal,sessionId,ciphertext)=>{
   const value=keys.get(sessionId);if(principal!==config.project.owner||!value)return false;
   try{const decoded=boundary.decrypt(value.key,value.variant,boundary.decodeBase64(ciphertext));return decoded!==null&&typeof decoded==='object';}catch{return false;}
  });
  const importer=new IsolatedImport(ledger,transport);
  if(descriptor.action==='stage'){
   bundleBytes=await outside(descriptor.bundleFile,32*1024*1024);
   const bundle=ImportBundle.parse(JSON.parse(bundleBytes.toString('utf8')));
   if(bundle.projectId!==config.project.id)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   if(bundle.contexts.length!==keys.size||bundle.contexts.some(context=>!keys.has(context.sessionId)))throw new Refusal('IMPORT_SESSION_KEY_SCOPE_MISMATCH',403);
   return await importer.stage(config.project.owner,bundle);
  }
  const batch=(await ledger.pool.query('SELECT project_id FROM ac_import_batches WHERE id=$1 AND principal_id=$2',[descriptor.importId,config.project.owner])).rows[0];
  if(batch?.project_id!==config.project.id)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
  const sessions=(await ledger.pool.query('SELECT session_id FROM ac_import_entries WHERE batch_id=$1',[descriptor.importId])).rows;
  if(sessions.length!==keys.size||sessions.some(row=>!keys.has(row.session_id)))throw new Refusal('IMPORT_SESSION_KEY_SCOPE_MISMATCH',403);
  return await importer.deliver(config.project.owner,descriptor.importId);
 }finally{bytes.fill(0);tokenBytes?.fill(0);bundleBytes?.fill(0);for(const value of keys.values())value.key.fill(0);keys.clear();}
}
