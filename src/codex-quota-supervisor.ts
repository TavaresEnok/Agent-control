import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fstatSync} from 'node:fs';
import type {Ledger} from './ledger.ts';
import {Refusal} from './contracts.ts';
import type {CodexReadonlySupervisor} from './codex-readonly-quota-source.ts';
const exec=promisify(execFile);
/** Container identity and journal survive controller death. No Docker socket is mounted.
 * Fixed image/command only; network disabled deliberately limits this executor to lab fixtures. */
export class CodexQuotaDockerSupervisor implements CodexReadonlySupervisor{
 private runId?:string;
 constructor(private readonly ledger:Ledger,private readonly binding:{accountId:string;subjectDigest:string},private readonly image:string){
  if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new TypeError('QUOTA_IMAGE_DIGEST_REQUIRED');
 }
 private async docker(args:string[]){return (await exec('docker',args,{timeout:5000,maxBuffer:512*1024,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}})).stdout;}
 async launch(input:{home:string;homeFd:number}):Promise<ChildProcess>{
  const id=randomUUID(),name='ac-r3-quota-'+id;
  const homeStat=fstatSync(input.homeFd,{bigint:true});
  const preflight="import{statSync}from'node:fs';const s=statSync('/quota-home',{bigint:true});if(String(s.dev)!=="+JSON.stringify(String(homeStat.dev))+"||String(s.ino)!=="+JSON.stringify(String(homeStat.ino))+"||String(s.uid)!=="+JSON.stringify(String(homeStat.uid))+"||(s.mode&0o7777n)!==0o700n)process.exit(91);await import('/fixture.mjs');";
  await this.ledger.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72))',[this.binding.accountId]);await c.query(`INSERT INTO ac_readonly_quota_runs(id,account_id,resource_name,subject_digest,state) VALUES($1,$2,$3,$4,'uncertain')`,[id,this.binding.accountId,name,this.binding.subjectDigest]);});
  this.runId=id;
  try{
   // No --rm: a stopped receipt remains inspectable after loss of the client.
   await this.ledger.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72))',[this.binding.accountId]);
   const state=(await c.query('SELECT state FROM ac_readonly_quota_runs WHERE id=$1',[id])).rows[0];
   if(state?.state!=='uncertain')throw new Refusal('QUOTA_RUN_SUPERSEDED');
   const container=(await this.docker(['create','--name',name,'--label','ac.lab=disposable','--label','ac.quota.run='+id,'--label','ac.quota.account='+this.binding.accountId,
    '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','64m','--cpus','0.25','--user',String(process.geteuid?.()??0),
    '--mount',`type=bind,src=${input.home},dst=/quota-home`,'--env','HOME=/quota-home','--env','CODEX_HOME=/quota-home','--workdir','/quota-home','-i','--entrypoint','node',this.image,'--input-type=module','-e',preflight,'app-server'])).trim();
   if(!/^[a-f0-9]{64}$/.test(container))throw new Refusal('QUOTA_RESOURCE_ID_INVALID');
   await c.query('UPDATE ac_readonly_quota_runs SET resource_id=$2 WHERE id=$1 AND state=\'uncertain\'',[id,container]);
   });
   const container=(await this.ledger.pool.query('SELECT resource_id FROM ac_readonly_quota_runs WHERE id=$1',[id])).rows[0].resource_id;
   return spawn('docker',['start','--attach','--interactive',container],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}});
  }catch{await this.stop();throw new Refusal('QUOTA_LAUNCH_UNAVAILABLE');}
 }
 async stop():Promise<boolean>{return this.runId?this.reconcile(this.runId,true):false;}
 async reconcile(id:string,ownedStop=false):Promise<boolean>{
  return this.ledger.tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72))',[this.binding.accountId]);
  const row=(await c.query('SELECT * FROM ac_readonly_quota_runs WHERE id=$1 AND account_id=$2',[id,this.binding.accountId])).rows[0];
  if(!row||row.subject_digest!==this.binding.subjectDigest)return false;
  const live=(await c.query('SELECT 1 FROM ac_provider_bindings WHERE account_id=$1 AND lease_until>clock_timestamp() AND NOT probe_uncertain',[this.binding.accountId])).rowCount;
  if(live&&!ownedStop)return false;
  const other=(await c.query("SELECT 1 FROM ac_readonly_quota_runs WHERE account_id=$1 AND state='uncertain' AND id<>$2",[this.binding.accountId,id])).rowCount;if(other)return false;
  try{
   // Listing by exact immutable name permits recovery if create ACK or ID persistence was lost.
   const ids=(await this.docker(['ps','-a','--no-trunc','--filter','name=^/'+row.resource_name+'$','--format','{{.ID}}'])).trim().split('\n').filter(Boolean);
   if(ids.length>1||!ids.length&&!row.resource_id)return false;
   if(ids.length){
    const info=JSON.parse(await this.docker(['inspect',ids[0]]))[0];
    if(info.Name!=='/'+row.resource_name||info.Config.Labels?.['ac.quota.run']!==id||info.Config.Labels?.['ac.quota.account']!==row.account_id||row.resource_id&&info.Id!==row.resource_id)return false;
    await this.docker(['rm','--force',info.Id]);
    // Successful daemon removal proves the entire container cgroup is gone, including setsid children.
   }
   {
    await c.query("UPDATE ac_readonly_quota_runs SET state='stopped',stopped_at=clock_timestamp() WHERE id=$1 AND state='uncertain'",[id]);
    // Only expired/uncertain leases may be reconciled; no live observation is superseded.
    const b=(await c.query('SELECT *,lease_until<clock_timestamp() expired FROM ac_provider_bindings WHERE account_id=$1 FOR UPDATE',[row.account_id])).rows[0];
    if(b&&(b.probe_uncertain||b.expired)){
     await c.query("UPDATE ac_provider_observations SET state='superseded' WHERE account_id=$1 AND state='collecting' AND lease_id=$2",[row.account_id,b.lease_id]);
     await c.query('UPDATE ac_provider_bindings SET probe_uncertain=false,lease_id=NULL,lease_until=NULL WHERE account_id=$1',[row.account_id]);
    }
   }return true;
  }catch{return false;}
  });
 }
 async reconcilePending():Promise<number>{
  const rows=await this.ledger.pool.query("SELECT id FROM ac_readonly_quota_runs WHERE account_id=$1 ORDER BY started_at DESC LIMIT 1",[this.binding.accountId]);
  let stopped=0;for(const row of rows.rows)if(await this.reconcile(row.id))stopped++;return stopped;
 }
}
