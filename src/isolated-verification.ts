import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {Authority,Id,digest,Refusal} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {SandboxClient} from './sandbox-client.ts';
const exec=promisify(execFile),GitId=z.string().regex(/^[a-f0-9]{40}$/);
const Launch=z.object({profile:z.literal('synthetic-verification-v1'),source:z.object({base:GitId,bundle:z.string().max(1400000)}).strict(),
 verification:z.object({artifactId:Id,operationId:Id,kind:z.enum(['qa','review','judge'])}).strict()}).strict();
const Result=z.object({jobId:Id,containerId:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int(),verification:z.object({
 artifactId:Id,operationId:Id,kind:z.enum(['qa','review','judge']),commit:GitId,tree:GitId,base:GitId,
 verifierDigest:z.string().regex(/^[a-f0-9]{64}$/),output:z.string().max(65536),nodeVersion:z.string()}).strict().nullable()}).passthrough();
async function git(cwd:string,args:string[]){
 const result=await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],{
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000,maxBuffer:2000000});
 return result.stdout.trim();
}
/** Fixed verifier in a separate container with read-only code and no controller keys. */
export class IsolatedVerification{
 private active=true;
 private readonly stops=new Set<()=>void>();
 constructor(readonly ledger:Ledger,readonly client:SandboxClient){}
 close(){this.active=false;for(const stop of this.stops)stop();}
 async run(principal:string,stageId:string,grantId:string,authority:Authority,cwd:string,
  artifact:{id:string;commit:string;tree:string;base:string},operationId:string,kind:'qa'|'review'|'judge',verifierDigest:string,isCanceled:()=>boolean){
  const parent=resolve('.state/isolated-artifacts');await mkdir(parent,{recursive:true,mode:0o700});const temporary=await mkdtemp(join(parent,'verify-'));
  let launch:z.infer<typeof Launch>|undefined,stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;if(launch)void this.client.perform('stop',stageId,grantId,authority,launch).catch(()=>{});};
  this.stops.add(stop);
  try{
   if(await git(cwd,['rev-parse','HEAD'])!==artifact.commit||await git(cwd,['rev-parse','HEAD^{tree}'])!==artifact.tree)
    throw new Refusal('ARTIFACT_TREE_MISMATCH');
   const bundlePath=join(temporary,'source.bundle');await git(cwd,['bundle','create',bundlePath,'HEAD']);
   const bundle=await readFile(bundlePath);if(bundle.length>1000000)throw new Refusal('SANDBOX_SOURCE_TOO_LARGE');
   launch=Launch.parse({profile:'synthetic-verification-v1',source:{base:artifact.commit,bundle:bundle.toString('base64')},verification:{artifactId:artifact.id,operationId,kind}});
   const snapshot=launch;
   await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);
    const intent=(await c.query('SELECT intent_id FROM ac_stage_operations WHERE id=$1',[stageId])).rows[0];
    if(!intent)throw new Refusal('STAGE_MISSING');
    await this.ledger.assertIntentActive(c,authority.contextId,intent.intent_id);
    if(!this.active||isCanceled())throw new Refusal('STAGE_CANCELED');
    const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 FOR UPDATE',[stageId])).rows[0];
    if(stage?.state!=='registered'||Number(stage.manager_epoch)!==authority.epoch||stage.node_id!==kind)
     throw new Refusal('STAGE_RECONCILIATION_REQUIRED');
    await c.query('INSERT INTO ac_stage_execution_launches(stage_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',
     [stageId,authority.contextId,authority.epoch,snapshot,digest(snapshot)]);
    await c.query("UPDATE ac_stage_operations SET state='uncertain',grant_id=$2 WHERE id=$1",[stageId,grantId]);
   });
   if(!this.active||isCanceled())throw new Refusal('STAGE_CANCELED');
   let response:unknown;
   try{response=await this.client.perform('start',stageId,grantId,authority,launch);}
   catch{response=await this.client.perform('reconcile',stageId,grantId,authority,launch);}
   const started=z.object({state:z.literal('running'),containerId:z.string()}).passthrough().safeParse(response);
   if(started.success)await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority,true);
    await c.query("UPDATE ac_stage_operations SET state='running',handle=$2,started_at=clock_timestamp() WHERE id=$1 AND state='uncertain' AND manager_epoch=$3",
     [stageId,{containerId:started.data.containerId,synthetic:true},authority.epoch]);
   });
   for(let i=0;i<240;i++){
    const terminal=Result.safeParse(response);
    if(terminal.success){
     const result=terminal.data,verification=result.verification;
     if(result.jobId!==stageId||!verification||verification.artifactId!==artifact.id||verification.operationId!==operationId||
       verification.kind!==kind||verification.commit!==artifact.commit||verification.tree!==artifact.tree||verification.base!==artifact.base||verification.verifierDigest!==verifierDigest)
      throw new Refusal('SANDBOX_VERIFICATION_INVALID');
     return {...verification,exitCode:result.exitCode,containerId:result.containerId};
    }
    if(!this.active||isCanceled()){stop();throw new Refusal('STAGE_CANCELED');}
    await new Promise(r=>setTimeout(r,250));response=await this.client.perform('reconcile',stageId,grantId,authority,launch);
   }
   throw new Refusal('SANDBOX_RESULT_UNCERTAIN');
  }finally{this.stops.delete(stop);await rm(temporary,{recursive:true,force:true});}
 }
 async cleanup(stageId:string,grantId:string,authority:Authority){
  const row=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_stage_execution_launches WHERE stage_id=$1 AND context_id=$2',[stageId,authority.contextId])).rows[0];
  if(!row)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
  const launch=Launch.parse(row.snapshot);if(digest(launch)!==row.digest)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
  return this.client.perform('cleanup',stageId,grantId,authority,launch);
 }
}
