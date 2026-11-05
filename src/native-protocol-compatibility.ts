import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {z} from 'zod';
import type pg from 'pg';
import {Ledger} from './ledger.ts';
import {digest,Refusal} from './contracts.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {nativePlanningExecutorDigest} from './native-planning-contract.ts';

const run=promisify(execFile),Hash=z.string().regex(/^[a-f0-9]{64}$/),Image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Effort=z.enum(['low','medium','high']);
const Model=z.object({model:z.string().min(1).max(100),efforts:z.array(Effort).min(1).max(3)}).strict();
const Models=z.array(Model).min(1).max(500).refine(rows=>new Set(rows.map(row=>row.model)).size===rows.length);
const Spec=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('execution'),workerImage:Image,toolsImage:Image,executorDigest:Hash}).strict(),
 z.object({kind:z.literal('planning'),workerImage:Image,executorDigest:Hash}).strict(),
]);
export type NativeProtocolSpec=z.infer<typeof Spec>;
const protocol='codex-app-server-initialize-model-list-v1';
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8'};
type Probe={id:string;executor_digest:string;worker_image:string;phase:'version'|'rpc';container_name:string;container_id:string|null;deadline_ms:string|number;retired:boolean};
// Runs as PID1 independently from the verifier. Exiting this PID tears down the
// entire PID namespace, including descendants that escaped into another session.
const watchdog=`const {spawn}=require('node:child_process');
const phase=process.argv[1],deadline=Number(process.argv[2]);
if(!['version','rpc'].includes(phase)||!Number.isSafeInteger(deadline)||Date.now()>=deadline)process.exit(124);
let child;const finish=code=>{try{if(child?.pid)process.kill(-child.pid,'SIGKILL');}catch{}process.exit(code);};
const timer=setTimeout(()=>finish(124),Math.max(1,deadline-Date.now()));
child=spawn('/usr/local/bin/codex',[phase==='version'?'--version':'app-server'],{stdio:'inherit',detached:true});
child.on('error',()=>finish(127));child.on('exit',code=>{clearTimeout(timer);finish(code??125);});
process.on('SIGTERM',()=>finish(143));process.on('SIGINT',()=>finish(130));`;
const dockerArgs=(op:Probe)=>['run','--name',op.container_name,'--label','agent-control.protocol-check=true','--label','agent-control.protocol-image='+op.worker_image,'--label','agent-control.protocol-operation='+op.id,'--label','agent-control.protocol-deadline='+op.deadline_ms,'--network','none','--read-only','--user','65534:65534','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','128m','--cpus','0.5','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--env','HOME=/tmp','--entrypoint','/usr/local/bin/node',...(op.phase==='rpc'?['-i']:[]),op.worker_image,'-e',watchdog,op.phase,String(op.deadline_ms)];
async function inspectProbe(name:string){
 try{return JSON.parse((await run('docker',['inspect',name],{env,timeout:10000,maxBuffer:262144})).stdout)[0] as Record<string,any>;}
 catch(error){if(String((error as {stderr?:string}).stderr??'').includes('No such object'))return null;throw new Refusal('NATIVE_PROTOCOL_CLEANUP_UNCERTAIN');}
}
async function retireProbe(ledger:Ledger,op:Probe){
 const container=await inspectProbe(op.container_name);
 if(!container){
  // Before the absolute deadline a delayed create remains possible. Keep the
  // operation uncertain. A late watchdog refuses any spawn after that deadline.
  if(Date.now()<Number(op.deadline_ms))throw new Refusal('NATIVE_PROTOCOL_CLEANUP_UNCERTAIN');
  await ledger.pool.query('UPDATE ac_native_protocol_probe_operations SET retired=true WHERE id=$1',[op.id]);return;
 }
 if(!/^[a-f0-9]{64}$/.test(container.Id)||container.Image!==op.worker_image||(op.container_id&&container.Id!==op.container_id)||
  container.Config?.Labels?.['agent-control.protocol-operation']!==op.id||container.Config?.Labels?.['agent-control.protocol-deadline']!==String(op.deadline_ms)||
  container.Config?.Labels?.['agent-control.protocol-image']!==op.worker_image||container.HostConfig?.NetworkMode!=='none'||container.HostConfig?.ReadonlyRootfs!==true||
  container.Config?.User!=='65534:65534'||container.HostConfig?.Privileged!==false||container.HostConfig?.PidMode==='host'||digest(container.Config?.Entrypoint)!==digest(['/usr/local/bin/node'])||digest(container.Config?.Cmd)!==digest(['-e',watchdog,op.phase,String(op.deadline_ms)])||!Array.isArray(container.Mounts)||container.Mounts.some((mount:any)=>mount.Type!=='tmpfs'||mount.Destination!=='/tmp'))throw new Refusal('NATIVE_PROTOCOL_PROBE_IDENTITY_MISMATCH');
 await ledger.tx(async c=>{const current=(await c.query('SELECT * FROM ac_native_protocol_probe_operations WHERE id=$1 FOR UPDATE',[op.id])).rows[0];if(!current||current.container_id&&current.container_id!==container.Id)throw new Refusal('NATIVE_PROTOCOL_PROBE_IDENTITY_MISMATCH');await c.query('UPDATE ac_native_protocol_probe_operations SET container_id=$2 WHERE id=$1',[op.id,container.Id]);});
 try{await run('docker',['rm','-f',container.Id],{env,timeout:10000,maxBuffer:65536});}catch{throw new Refusal('NATIVE_PROTOCOL_CLEANUP_UNCERTAIN');}
 if(await inspectProbe(container.Id))throw new Refusal('NATIVE_PROTOCOL_CLEANUP_UNCERTAIN');
 await ledger.pool.query('UPDATE ac_native_protocol_probe_operations SET retired=true WHERE id=$1',[op.id]);
}
async function observe(spec:NativeProtocolSpec,ledger:Ledger){
 // No caller-provided runner, path, command, environment, transcript or success flag.
 const begin=async(phase:'version'|'rpc'):Promise<Probe>=>{const id=randomUUID(),name='ac-protocol-'+phase+'-'+id,deadline=Date.now()+15000;return (await ledger.pool.query<Probe>('INSERT INTO ac_native_protocol_probe_operations(id,executor_digest,worker_image,phase,container_name,deadline_ms) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,spec.executorDigest,spec.workerImage,phase,name,deadline])).rows[0];};
 const version=await begin('version');
 let cliVersion:string;
 try{const output=await run('docker',dockerArgs(version),{env,timeout:15000,maxBuffer:8192});
  if(output.stderr.trim())throw new Refusal('NATIVE_PROTOCOL_VERSION_INVALID');cliVersion=z.string().regex(/^codex(?:-cli)? \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/).parse(output.stdout.trim());
 }catch(error){throw error instanceof Refusal?error:new Refusal('NATIVE_PROTOCOL_VERSION_INVALID');}finally{await retireProbe(ledger,version);}
 const rpc=await begin('rpc');
 const child=spawn('docker',dockerArgs(rpc),{env,stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout});const transcript:unknown[]=[];
 let bytes=0,stderr=0,failure:Error|undefined;const pending=new Map<string,{resolve:(v:unknown)=>void;reject:(e:Error)=>void}>();
 const fail=(error:Error)=>{failure??=error;for(const item of pending.values())item.reject(error);pending.clear();};
 const timer=setTimeout(()=>fail(new Refusal('NATIVE_PROTOCOL_TIMEOUT')),15000);
 child.stdin.on('error',()=>fail(new Refusal('NATIVE_PROTOCOL_PROCESS_FAILED')));child.stdout.on('error',()=>fail(new Refusal('NATIVE_PROTOCOL_PROCESS_FAILED')));child.stderr.on('error',()=>fail(new Refusal('NATIVE_PROTOCOL_PROCESS_FAILED')));lines.on('error',()=>fail(new Refusal('NATIVE_PROTOCOL_PROCESS_FAILED')));
 child.on('error',()=>fail(new Refusal('NATIVE_PROTOCOL_PROCESS_FAILED')));child.on('exit',()=>fail(new Refusal('NATIVE_PROTOCOL_PROCESS_EXITED')));
 child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.length;if(stderr>8192)fail(new Refusal('NATIVE_PROTOCOL_OUTPUT_INVALID'));});
 child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>262144){fail(new Refusal('NATIVE_PROTOCOL_OUTPUT_INVALID'));child.stdout.destroy();}});
 lines.on('line',line=>{if(failure)return;
  try{const message=JSON.parse(line);if(typeof message.id!=='string'||!pending.has(message.id))throw Error('unexpected message');
   const promise=pending.get(message.id)!;pending.delete(message.id);transcript.push(message);
   if(message.error)promise.reject(new Refusal('NATIVE_PROTOCOL_REJECTED'));else if(!('result' in message))promise.reject(new Refusal('NATIVE_PROTOCOL_OUTPUT_INVALID'));else promise.resolve(message.result);
  }catch{fail(new Refusal('NATIVE_PROTOCOL_OUTPUT_INVALID'));}
 });
 const request=(method:string,params:unknown)=>new Promise<unknown>((resolve,reject)=>{if(failure){reject(failure);return;}const id=randomUUID();pending.set(id,{resolve,reject});const value={id,method,params};transcript.push(value);child.stdin.write(JSON.stringify(value)+'\n');});
 try{
  const initialized=z.object({userAgent:z.string().min(1).max(300)}).passthrough().parse(await request('initialize',{clientInfo:{name:'agent-control-protocol-check',version:'1.0.0'},capabilities:{experimentalApi:true}}));
  if(!initialized.userAgent)throw new Refusal('NATIVE_PROTOCOL_OUTPUT_INVALID');
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const models:z.infer<typeof Model>[]=[],seen=new Set<string>();let cursor:string|null=null;
  for(let page=0;page<25;page++){
   const response=z.object({data:z.array(z.object({model:z.string().min(1).max(100),hidden:z.boolean().optional(),supportedReasoningEfforts:z.array(z.object({reasoningEffort:z.string()}).passthrough()).min(1)}).passthrough()).max(500),nextCursor:z.string().min(1).nullable().optional()}).passthrough().parse(await request('model/list',{cursor,includeHidden:false}));
   for(const item of response.data)if(!item.hidden){const efforts=[...new Set(item.supportedReasoningEfforts.map(row=>row.reasoningEffort).filter(value=>Effort.safeParse(value).success))] as z.infer<typeof Effort>[];models.push(Model.parse({model:item.model,efforts}));}
   if(models.length>500)throw new Refusal('NATIVE_PROTOCOL_OUTPUT_INVALID');cursor=response.nextCursor??null;if(cursor===null)return {cliVersion,protocol,models:Models.parse(models),transcriptDigest:digest(transcript)};
   if(seen.has(cursor))throw new Refusal('NATIVE_PROTOCOL_CURSOR_LOOP');seen.add(cursor);
  }
  throw new Refusal('NATIVE_PROTOCOL_PAGE_LIMIT');
 }catch(error){throw error instanceof Refusal?error:new Refusal('NATIVE_PROTOCOL_OUTPUT_INVALID');}
 finally{clearTimeout(timer);lines.close();child.stdin.destroy();child.kill('SIGKILL');await retireProbe(ledger,rpc);}
}
async function admin(c:pg.PoolClient,principal:string){if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);}
/** Host-local verifier only. The HTTP/control APIs cannot submit receipt bodies.
 * This checks credentialless protocol compatibility, never eligibility or auth. */
export class NativeProtocolCompatibility{
 constructor(readonly ledger:Ledger){}
 async verify(principal:string,raw:NativeProtocolSpec){
  const spec=Spec.parse(raw);if(spec.executorDigest!==(spec.kind==='execution'?nativeExecutionExecutorDigest(spec.workerImage,spec.toolsImage):nativePlanningExecutorDigest(spec.workerImage)))throw new Refusal('NATIVE_PROTOCOL_EXECUTOR_MISMATCH');
  await this.ledger.tx(c=>admin(c,principal));const observed=await observe(spec,this.ledger),id=randomUUID();
  await this.ledger.tx(async c=>{await admin(c,principal);await c.query(`INSERT INTO ac_native_protocol_receipts(id,executor_digest,kind,worker_image,tools_image,cli_version,protocol,models,transcript_digest,principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,spec.executorDigest,spec.kind,spec.workerImage,spec.kind==='execution'?spec.toolsImage:null,observed.cliVersion,protocol,JSON.stringify(observed.models),observed.transcriptDigest,principal]);});
  return {id,executorDigest:spec.executorDigest,...observed};
 }
 /** Bounded, resumable sweep includes retired tombstones too: delayed creates
  * can leave an already-exited container after a previous absent inspection. */
 async reconcile(principal:string,options:{afterId?:string;limit?:number}={}){
  const limit=z.number().int().min(1).max(100).parse(options.limit??100);if(options.afterId)z.uuid().parse(options.afterId);
  await this.ledger.tx(c=>admin(c,principal));
  const rows=(await this.ledger.pool.query<Probe>('SELECT * FROM ac_native_protocol_probe_operations WHERE deadline_ms<=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[Date.now(),options.afterId??null,limit+1])).rows;
  for(const row of rows.slice(0,limit))await retireProbe(this.ledger,row);
  return {reconciled:Math.min(rows.length,limit),nextAfterId:rows.length>limit?rows[limit-1].id:null};
 }
 async promote(principal:string,receiptId:string,expectedRevision:number){z.uuid().parse(receiptId);z.number().int().nonnegative().parse(expectedRevision);
  return this.ledger.tx(async c=>{await admin(c,principal);const receipt=(await c.query('SELECT * FROM ac_native_protocol_receipts WHERE id=$1',[receiptId])).rows[0];if(!receipt)throw new Refusal('NATIVE_PROTOCOL_RECEIPT_REQUIRED');
   await c.query('SELECT pg_advisory_xact_lock(189234,84)');const old=(await c.query('SELECT * FROM ac_native_protocol_promotions WHERE executor_digest=$1 FOR UPDATE',[receipt.executor_digest])).rows[0];if((old?.revision??0)!==expectedRevision)throw new Refusal('NATIVE_PROTOCOL_REVISION_CONFLICT');
   const revision=expectedRevision+1;await c.query(`INSERT INTO ac_native_protocol_promotions(executor_digest,receipt_id,revision) VALUES($1,$2,$3) ON CONFLICT(executor_digest) DO UPDATE SET receipt_id=$2,revision=$3,revoked=false,updated_at=clock_timestamp()`,[receipt.executor_digest,receiptId,revision]);return {revision};});
 }
 async revoke(principal:string,executorDigest:string,expectedRevision:number){Hash.parse(executorDigest);z.number().int().positive().parse(expectedRevision);return this.ledger.tx(async c=>{await admin(c,principal);const result=await c.query('UPDATE ac_native_protocol_promotions SET revoked=true,revision=revision+1,updated_at=clock_timestamp() WHERE executor_digest=$1 AND revision=$2 RETURNING revision',[executorDigest,expectedRevision]);if(!result.rowCount)throw new Refusal('NATIVE_PROTOCOL_REVISION_CONFLICT');return result.rows[0];});}
}
export async function pinNativeProtocolForNewAttempt(c:pg.PoolClient,input:{kind:'execution'|'planning';jobId:string;executorDigest:string;model:string;effort:'low'|'medium'|'high'}){
 const parsed=z.object({kind:z.enum(['execution','planning']),jobId:z.uuid(),executorDigest:Hash,model:z.string().min(1).max(100),effort:Effort}).strict().parse(input);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['native-protocol:'+parsed.kind+':'+parsed.jobId]);
 const prior=(await c.query('SELECT * FROM ac_native_protocol_attempt_pins WHERE kind=$1 AND job_id=$2',[parsed.kind,parsed.jobId])).rows[0];
 if(prior){if(prior.executor_digest!==parsed.executorDigest||prior.model!==parsed.model||prior.effort!==parsed.effort)throw new Refusal('NATIVE_PROTOCOL_PIN_CONFLICT');return {receiptId:prior.receipt_id as string};}
 const row=(await c.query(`SELECT r.* FROM ac_native_protocol_promotions p JOIN ac_native_protocol_receipts r ON r.id=p.receipt_id WHERE p.executor_digest=$1 AND NOT p.revoked AND r.executor_digest=$1 AND r.kind=$2 FOR SHARE OF p`,[parsed.executorDigest,parsed.kind])).rows[0];
 if(!row||row.protocol!==protocol||!Models.parse(row.models).some(item=>item.model===parsed.model&&item.efforts.includes(parsed.effort)))throw new Refusal('NATIVE_PROTOCOL_UNCONFIRMED');
 await c.query('INSERT INTO ac_native_protocol_attempt_pins(kind,job_id,executor_digest,receipt_id,model,effort) VALUES($1,$2,$3,$4,$5,$6)',[parsed.kind,parsed.jobId,parsed.executorDigest,row.id,parsed.model,parsed.effort]);return {receiptId:row.id as string};
}
