import {z} from 'zod';
import type pg from 'pg';
import type {Ledger} from './ledger.ts';
import {Id,Refusal,digest} from './contracts.ts';
import {Operators,type OperatorProof} from './operator.ts';

const epoch=z.number().int().positive();
export const InstallationToken=z.object({domainId:Id,installationId:Id,epoch}).strict();
export type InstallationToken=z.infer<typeof InstallationToken>;
const base={schemaVersion:z.literal(1),intentId:Id,deliveryAttemptId:Id,domainId:Id};
export const InstallationCommand=z.discriminatedUnion('action',[
 z.object({...base,action:z.literal('installation.pause'),payload:z.object({expectedEpoch:epoch,paused:z.boolean()}).strict()}).strict(),
 z.object({...base,action:z.literal('installation.transfer'),payload:z.object({expectedEpoch:epoch,targetInstallationId:Id}).strict()}).strict(),
 z.object({...base,action:z.literal('installation.rollback'),payload:z.object({expectedEpoch:epoch,targetInstallationId:Id}).strict()}).strict(),
]);
type Domain={id:string;holder_installation_id:string;epoch:number;paused:boolean};
/** Shared DB is the sole authority. Expiration never proves that a physical worker stopped.
 * This laboratory service cannot enroll or activate real installations/accounts. */
export class InstallationAuthority {
 constructor(readonly ledger:Ledger,private readonly verifyAbsence?:(identity:string,evidence:string)=>Promise<boolean>){}
 private async admin(c:pg.PoolClient,principal:string){
  if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
 }
 private async locked(c:pg.PoolClient,id:string):Promise<Domain>{
  const row=(await c.query<Domain>('SELECT id,holder_installation_id,epoch,paused FROM ac_installation_domains WHERE id=$1 FOR UPDATE',[Id.parse(id)])).rows[0];
  if(!row)throw new Refusal('INSTALLATION_DOMAIN_NOT_FOUND',404);return row;
 }
 private async token(c:pg.PoolClient,raw:InstallationToken,allowPaused=false){
  const token=InstallationToken.parse(raw),row=await this.locked(c,token.domainId);
  if(row.holder_installation_id!==token.installationId||row.epoch!==token.epoch)throw new Refusal('STALE_INSTALLATION_AUTHORITY');
  if(row.paused&&!allowPaused)throw new Refusal('INSTALLATION_PAUSED');return row;
 }
 private async event(c:pg.PoolClient,id:string,kind:string,detail:unknown){
  await c.query('INSERT INTO ac_installation_history(domain_id,kind,detail) VALUES($1,$2,$3)',[id,kind,detail]);
 }
 async initializeLaboratory(principal:string,raw:{domainId:string;label:string;oldInstallationId:string;newInstallationId:string;mode:'synthetic-laboratory'}){
  const input=z.object({domainId:Id,label:z.string().min(1).max(120),oldInstallationId:Id,newInstallationId:Id,mode:z.literal('synthetic-laboratory')}).strict().parse(raw);
  if(input.oldInstallationId===input.newInstallationId)throw new Refusal('INSTALLATION_IDENTITIES_EQUAL');
  return this.ledger.tx(async c=>{
   await this.admin(c,principal);
   await c.query('INSERT INTO ac_installation_domains(id,label,holder_installation_id) VALUES($1,$2,$3)',[input.domainId,input.label,input.oldInstallationId]);
   await c.query('INSERT INTO ac_installation_members(id,domain_id,label) VALUES($1,$3,\'old synthetic installation\'),($2,$3,\'new synthetic installation\')',[input.oldInstallationId,input.newInstallationId,input.domainId]);
   await this.event(c,input.domainId,'initialized',{holder:input.oldInstallationId,epoch:1,paused:true});
   return {domainId:input.domainId,installationId:input.oldInstallationId,epoch:1};
  });
 }
 async bindLaboratoryProject(principal:string,domainId:string,projectId:string){
  await this.ledger.tx(async c=>{await this.admin(c,principal);
   await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE',[Id.parse(projectId)]);
   await c.query('SELECT id FROM ac_contexts WHERE project_id=$1 ORDER BY id FOR UPDATE',[Id.parse(projectId)]);
   await this.locked(c,domainId);
   if((await c.query("SELECT 1 FROM ac_capacity_grants WHERE project_id=$1 AND state<>'released'",[Id.parse(projectId)])).rowCount)throw new Refusal('INSTALLATION_WORK_NOT_RECONCILED');
   if((await c.query("SELECT 1 FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1 AND a.mode<>'synthetic'",[projectId])).rowCount)throw new Refusal('INSTALLATION_SYNTHETIC_ACCOUNT_REQUIRED');
   if((await c.query('SELECT 1 FROM ac_account_access a JOIN ac_account_access b ON b.account_id=a.account_id JOIN ac_installation_projects p ON p.project_id=b.project_id WHERE a.project_id=$1 AND p.domain_id<>$2',[projectId,domainId])).rowCount)throw new Refusal('INSTALLATION_ACCOUNT_DOMAIN_CONFLICT');
   await c.query('INSERT INTO ac_installation_accounts(account_id,domain_id) SELECT account_id,$2 FROM ac_account_access WHERE project_id=$1 ORDER BY account_id ON CONFLICT(account_id) DO NOTHING',[projectId,domainId]);
   if((await c.query('SELECT 1 FROM ac_account_access a JOIN ac_installation_accounts d ON d.account_id=a.account_id WHERE a.project_id=$1 AND d.domain_id<>$2',[projectId,domainId])).rowCount)throw new Refusal('INSTALLATION_ACCOUNT_DOMAIN_CONFLICT');
   await c.query('INSERT INTO ac_installation_projects(project_id,domain_id) VALUES($1,$2)',[projectId,domainId]);
   await this.event(c,domainId,'project.bound',{projectId});});
 }
 async view(principal:string,domainId:string){
  return this.ledger.tx(async c=>{
   await this.admin(c,principal);const domain=await this.locked(c,domainId);
   const installations=(await c.query('SELECT id,label FROM ac_installation_members WHERE domain_id=$1 ORDER BY id',[domainId])).rows;
   const reservations=(await c.query('SELECT id,installation_id,epoch,operation_id,account_id,execution_identity,state,lease_until FROM ac_installation_reservations WHERE domain_id=$1 ORDER BY created_at,id',[domainId])).rows;
   const history=(await c.query('SELECT sequence,kind,detail,created_at FROM ac_installation_history WHERE domain_id=$1 ORDER BY sequence',[domainId])).rows;
   return {mode:'synthetic-laboratory' as const,operationalActivation:'blocked' as const,domain,installations,reservations,history};
  });
 }
 async execute(principal:string,raw:unknown,proof:OperatorProof){
  const command=InstallationCommand.parse(raw),{deliveryAttemptId,...semantic}=command,hash=digest({principal,...semantic});
  return this.ledger.tx(async c=>{
   await this.admin(c,principal);await new Operators(this.ledger).verify(c,principal,command,proof);
   const row=await this.locked(c,command.domainId);
   const prior=(await c.query('SELECT principal_id,payload_digest,result FROM ac_installation_commands WHERE id=$1',[command.intentId])).rows[0];
   if(prior){if(prior.principal_id!==principal||prior.payload_digest!==hash)throw new Refusal('INSTALLATION_INTENT_CONFLICT');return prior.result;}
   if(row.epoch!==command.payload.expectedEpoch)throw new Refusal('STALE_INSTALLATION_AUTHORITY');
   if(command.action==='installation.pause'){
    await c.query('UPDATE ac_installation_domains SET paused=$2 WHERE id=$1',[row.id,command.payload.paused]);
    row.paused=command.payload.paused;
   }else{
    if(!row.paused)throw new Refusal('INSTALLATION_MUST_BE_PAUSED');
    const target=command.payload.targetInstallationId;
    if(target===row.holder_installation_id||!(await c.query('SELECT 1 FROM ac_installation_members WHERE domain_id=$1 AND id=$2',[row.id,target])).rowCount)throw new Refusal('INSTALLATION_TARGET_INVALID');
    // No TTL shortcut: running and reserved work both need explicit not-started/absent receipt.
    if((await c.query("SELECT 1 FROM ac_installation_reservations WHERE domain_id=$1 AND state<>'released'",[row.id])).rowCount)throw new Refusal('INSTALLATION_WORK_NOT_RECONCILED');
    if((await c.query("SELECT 1 FROM ac_capacity_grants g JOIN ac_installation_projects p ON p.project_id=g.project_id WHERE p.domain_id=$1 AND g.state<>'released'",[row.id])).rowCount)throw new Refusal('INSTALLATION_WORK_NOT_RECONCILED');
    if((await c.query("SELECT 1 FROM ac_installation_refreshes WHERE domain_id=$1 AND state<>'finished'",[row.id])).rowCount)throw new Refusal('INSTALLATION_REFRESH_NOT_RECONCILED');
    if(command.action==='installation.rollback'){
     const latest=(await c.query("SELECT detail FROM ac_installation_history WHERE domain_id=$1 AND kind IN ('installation.transfer','installation.rollback') ORDER BY sequence DESC LIMIT 1",[row.id])).rows[0];
     if(!latest||latest.detail.from!==target)throw new Refusal('INSTALLATION_ROLLBACK_TARGET_INVALID');
    }
    const from=row.holder_installation_id;row.holder_installation_id=target;row.epoch++;
    await c.query('UPDATE ac_installation_domains SET holder_installation_id=$2,epoch=$3 WHERE id=$1',[row.id,target,row.epoch]);
    await this.event(c,row.id,command.action,{from,to:target,epoch:row.epoch,intentId:command.intentId});
   }
   if(command.action==='installation.pause')await this.event(c,row.id,command.action,{paused:row.paused,epoch:row.epoch,intentId:command.intentId});
   const result={state:'applied',token:{domainId:row.id,installationId:row.holder_installation_id,epoch:row.epoch},paused:row.paused};
   await c.query('INSERT INTO ac_installation_commands VALUES($1,$2,$3,$4)',[command.intentId,principal,hash,result]);return result;
  });
 }
 async reserve(principal:string,token:InstallationToken,raw:{id:string;operationId:string;accountId:string;executionIdentity:string;leaseSeconds:number}){
  const input=z.object({id:Id,operationId:Id,accountId:Id,executionIdentity:Id,leaseSeconds:z.number().int().min(1).max(60)}).strict().parse(raw);
  return this.ledger.tx(async c=>{
   await this.admin(c,principal);await this.token(c,token);
   const account=(await c.query('SELECT mode,enabled FROM ac_accounts WHERE id=$1 FOR UPDATE',[input.accountId])).rows[0];
   if(!account||account.mode!=='synthetic'||!account.enabled)throw new Refusal('INSTALLATION_SYNTHETIC_ACCOUNT_REQUIRED');
   if((await c.query('SELECT 1 FROM ac_account_access WHERE account_id=$1',[input.accountId])).rowCount)throw new Refusal('INSTALLATION_USE_CAPACITY_ADMISSION');
   await c.query('INSERT INTO ac_installation_accounts VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING',[input.accountId,token.domainId]);
   if(!(await c.query('SELECT 1 FROM ac_installation_accounts WHERE account_id=$1 AND domain_id=$2',[input.accountId,token.domainId])).rowCount)throw new Refusal('INSTALLATION_ACCOUNT_DOMAIN_MISMATCH');
   const prior=(await c.query('SELECT * FROM ac_installation_reservations WHERE domain_id=$1 AND operation_id=$2',[token.domainId,input.operationId])).rows[0];
   if(prior){if(prior.id!==input.id||prior.account_id!==input.accountId||prior.execution_identity!==input.executionIdentity||prior.installation_id!==token.installationId||prior.epoch!==token.epoch)throw new Refusal('INSTALLATION_OPERATION_CONFLICT');return prior;}
   // Serialize cross-domain/account use too. No expiry-based automatic release.
   if((await c.query("SELECT 1 FROM ac_installation_reservations WHERE account_id=$1 AND state<>'released'",[input.accountId])).rowCount)throw new Refusal('INSTALLATION_ACCOUNT_BUSY');
   const row=(await c.query("INSERT INTO ac_installation_reservations(id,domain_id,installation_id,epoch,operation_id,account_id,execution_identity,state,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',clock_timestamp()+$8*interval '1 second') RETURNING *",[input.id,token.domainId,token.installationId,token.epoch,input.operationId,input.accountId,input.executionIdentity,input.leaseSeconds])).rows[0];
   await this.event(c,token.domainId,'reservation.created',{id:input.id,operationId:input.operationId,epoch:token.epoch});return row;
  });
 }
 /** The durable claim precedes the physical start callback, which holds a fenced transaction. Retry never invokes start twice.
  * The durable claim commits first; the callback then holds the domain lock. A crash leaves running work blocking transfer. */
 async start(principal:string,token:InstallationToken,id:string,start:(identity:string)=>Promise<void>){
  return this.ledger.tx(async c=>{
   await this.admin(c,principal);await this.token(c,token);
   const row=await this.reservation(c,token,id);
   if(row.state!=='reserved')throw new Refusal('INSTALLATION_EXECUTION_ALREADY_STARTED');
   if(!row.valid)throw new Refusal('INSTALLATION_RESERVATION_EXPIRED');
   // Commit running before physical side effect. Never roll back to reserved on callback failure.
   await c.query("UPDATE ac_installation_reservations SET state='running' WHERE id=$1",[id]);
   await this.event(c,token.domainId,'execution.start_claimed',{id,executionIdentity:row.execution_identity});
   return row.execution_identity as string;
  }).then(async identity=>{try{await this.ledger.tx(async c=>{await this.token(c,token);const row=await this.reservation(c,token,id);if(row.state!=='running')throw new Refusal('INSTALLATION_EXECUTION_NOT_RUNNING');await start(identity);});}catch(error){await this.markUncertain(principal,token,id);throw error;}});
 }
 private async reservation(c:pg.PoolClient,token:InstallationToken,id:string){
  const row=(await c.query('SELECT *,lease_until>clock_timestamp() valid FROM ac_installation_reservations WHERE id=$1 AND domain_id=$2 AND installation_id=$3 AND epoch=$4 FOR UPDATE',[Id.parse(id),token.domainId,token.installationId,token.epoch])).rows[0];
  if(!row)throw new Refusal('INSTALLATION_RESERVATION_FORBIDDEN',403);return row;
 }
 async renew(principal:string,token:InstallationToken,id:string,leaseSeconds=30){
  z.number().int().min(1).max(60).parse(leaseSeconds);
  await this.ledger.tx(async c=>{await this.admin(c,principal);await this.token(c,token,true);const row=await this.reservation(c,token,id);
   if(!row.valid||!['reserved','running'].includes(row.state))throw new Refusal('INSTALLATION_RENEWAL_REFUSED');
   await c.query("UPDATE ac_installation_reservations SET lease_until=clock_timestamp()+$2*interval '1 second' WHERE id=$1",[id,leaseSeconds]);
   await this.event(c,token.domainId,'reservation.renewed',{id,epoch:token.epoch});});
 }
 async markUncertain(principal:string,token:InstallationToken,id:string){
  await this.ledger.tx(async c=>{await this.admin(c,principal);await this.token(c,token,true);const row=await this.reservation(c,token,id);
   if(row.state==='released')throw new Refusal('INSTALLATION_ALREADY_RELEASED');
   await c.query("UPDATE ac_installation_reservations SET state='uncertain' WHERE id=$1",[id]);await this.event(c,token.domainId,'execution.uncertain',{id});});
 }
 async release(principal:string,token:InstallationToken,id:string,receipt:{executionIdentity:string;state:'not_started'|'absent';evidence:string}){
  const proof=z.object({executionIdentity:Id,state:z.enum(['not_started','absent']),evidence:z.string().min(1).max(200)}).strict().parse(receipt);
  await this.ledger.tx(async c=>{await this.admin(c,principal);await this.token(c,token,true);const row=await this.reservation(c,token,id);
   if(row.execution_identity!==proof.executionIdentity||(proof.state==='not_started'&&row.state!=='reserved'&&row.state!=='released'))throw new Refusal('INSTALLATION_ABSENCE_IDENTITY_MISMATCH');
   if(row.state==='released')return;
   if(proof.state==='absent'&&(!this.verifyAbsence||!await this.verifyAbsence(row.execution_identity,proof.evidence)))throw new Refusal('INSTALLATION_ABSENCE_UNPROVEN');
   await c.query("UPDATE ac_installation_reservations SET state='released',absence_evidence=$2 WHERE id=$1",[id,proof.evidence]);
   await this.event(c,token.domainId,'reservation.released',{id,...proof});});
 }
 /** Synthetic credential adapter only. Durable claim prevents overlap after lost ACK/crash. */
 async refreshCredentials(principal:string,token:InstallationToken,accountId:string,operationId:string,refresh:()=>Promise<void>){
  Id.parse(accountId);Id.parse(operationId);
  await this.ledger.tx(async c=>{await this.admin(c,principal);await this.token(c,token,true);
   if(!(await c.query("SELECT 1 FROM ac_accounts WHERE id=$1 AND mode='synthetic' FOR UPDATE",[accountId])).rowCount)throw new Refusal('INSTALLATION_SYNTHETIC_ACCOUNT_REQUIRED');
   if(!(await c.query('SELECT 1 FROM ac_installation_accounts WHERE account_id=$1 AND domain_id=$2',[accountId,token.domainId])).rowCount)throw new Refusal('INSTALLATION_ACCOUNT_DOMAIN_MISMATCH');
   if((await c.query("SELECT 1 FROM ac_installation_refreshes WHERE account_id=$1 AND state<>'finished'",[accountId])).rowCount)throw new Refusal('INSTALLATION_REFRESH_ACCOUNT_BUSY');
   if((await c.query('SELECT 1 FROM ac_installation_refreshes WHERE id=$1',[operationId])).rowCount)throw new Refusal('INSTALLATION_REFRESH_ALREADY_CLAIMED');
   await c.query("INSERT INTO ac_installation_refreshes VALUES($1,$2,$3,$4,$5,'claimed')",[operationId,token.domainId,token.installationId,token.epoch,accountId]);});
  try{await this.ledger.tx(async c=>{await this.token(c,token,true);await refresh();
   await c.query("UPDATE ac_installation_refreshes SET state='finished' WHERE id=$1",[operationId]);
   await this.event(c,token.domainId,'credentials.refreshed',{accountId,operationId,epoch:token.epoch});});}
  catch(error){await this.ledger.tx(async c=>{await this.locked(c,token.domainId);await c.query("UPDATE ac_installation_refreshes SET state='uncertain' WHERE id=$1",[operationId]);});throw error;}
 }
 async reconcileRefresh(principal:string,token:InstallationToken,operationId:string,evidence:string){
  await this.ledger.tx(async c=>{await this.admin(c,principal);await this.token(c,token,true);
   const row=(await c.query('SELECT * FROM ac_installation_refreshes WHERE id=$1 AND domain_id=$2 FOR UPDATE',[Id.parse(operationId),token.domainId])).rows[0];
   if(!row||!this.verifyAbsence||!await this.verifyAbsence(operationId,evidence))throw new Refusal('INSTALLATION_ABSENCE_UNPROVEN');
   await c.query("UPDATE ac_installation_refreshes SET state='finished' WHERE id=$1",[operationId]);
   await this.event(c,token.domainId,'credentials.reconciled',{operationId,evidence});});
 }

}
