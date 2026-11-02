import {z} from 'zod';
import type pg from 'pg';
import {Id,digest,Refusal} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {ProviderAdapterId} from './providers.ts';

const SourceURL=z.string().max(2048).url().refine(value=>{
 try{const parsed=new URL(value);return parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash;}catch{return false;}
},'HTTPS_SOURCE_REQUIRED');
export const ProviderEligibilityInput=z.object({
 accountId:Id,expectedRevision:z.number().int().nonnegative(),plan:z.string().trim().min(1).max(200),
 adapterId:ProviderAdapterId,adapterVersion:ProviderAdapterId,
 authenticationMode:z.enum(['subscription_oauth','api_key','synthetic']),
 executionMode:z.enum(['central_isolated_cli','api','synthetic']),sourceURL:SourceURL,
 status:z.enum(['documented_supported','requires_clarification','unsupported_for_mode','not_assessed']),
 reason:z.string().trim().min(1).max(2000),reviewedAt:z.iso.datetime({offset:true}),validForSeconds:z.number().int().min(1).max(2592000),
}).strict();
export type ProviderEligibilityInput=z.infer<typeof ProviderEligibilityInput>;
function modeCompatible(mode:string,input:ProviderEligibilityInput){
 return (mode==='synthetic'&&input.authenticationMode==='synthetic'&&input.executionMode==='synthetic')||
  (mode==='subscription_cli'&&input.authenticationMode==='subscription_oauth'&&input.executionMode==='central_isolated_cli')||
  (mode==='api'&&input.authenticationMode==='api_key'&&input.executionMode==='api');
}
function projectRow(row:pg.QueryResultRow){
 const parsed=ProviderEligibilityInput.safeParse(row.request_snapshot);
 if(!parsed.success||parsed.data.accountId!==row.account_id||parsed.data.expectedRevision!==row.revision-1||
   digest({principal:row.principal_id,projectId:row.project_id,input:parsed.data,provider:row.provider,mode:row.account_mode})!==row.request_digest||
   parsed.data.plan!==row.plan||parsed.data.adapterId!==row.adapter_id||parsed.data.adapterVersion!==row.adapter_version||
   parsed.data.authenticationMode!==row.authentication_mode||parsed.data.executionMode!==row.execution_mode||parsed.data.sourceURL!==row.source_url||
   parsed.data.status!==row.status||parsed.data.reason!==row.reason||parsed.data.validForSeconds!==row.valid_for_seconds||
   Date.parse(parsed.data.reviewedAt)!==(row.reviewed_at as Date).getTime()||
   (row.expires_at as Date).getTime()!==(row.reviewed_at as Date).getTime()+parsed.data.validForSeconds*1000||
   typeof row.provider!=='string'||!row.provider||!modeCompatible(row.account_mode,parsed.data))throw new Refusal('PROVIDER_ELIGIBILITY_CORRUPT');
 const fresh=Boolean(row.fresh&&row.current_provider===row.provider&&row.current_mode===row.account_mode);
 return {accountId:row.account_id,revision:row.revision,provider:row.provider,accountMode:row.account_mode,plan:row.plan,adapterId:row.adapter_id,
  adapterVersion:row.adapter_version,authenticationMode:row.authentication_mode,executionMode:row.execution_mode,sourceURL:row.source_url,
  status:row.status,effectiveStatus:fresh?row.status:'not_assessed',reason:row.reason,reviewedAt:(row.reviewed_at as Date).toISOString(),
  validForSeconds:row.valid_for_seconds,expiresAt:(row.expires_at as Date).toISOString(),fresh};
}
const projection=`e.*,a.provider current_provider,a.mode current_mode,
 e.reviewed_at<=clock_timestamp() AND e.expires_at>clock_timestamp() fresh`;

/** Immutable reviewed metadata only. It neither activates a provider nor
 * collects quota or credentials; the frozen account mode determines scope. */
export class ProviderEligibility{
 constructor(readonly ledger:Ledger,private readonly client?:pg.PoolClient){}
 private tx<T>(fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{return this.client?fn(this.client):this.ledger.tx(fn);}
 async publish(principal:string,projectId:string,raw:z.input<typeof ProviderEligibilityInput>){
  Id.parse(projectId);const input=ProviderEligibilityInput.parse(raw);
  return this.tx(async c=>{
   const account=(await c.query(`SELECT a.id,a.provider,a.mode FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id
    JOIN ac_memberships m ON m.project_id=x.project_id WHERE a.id=$1 AND a.owner_id=$2 AND x.project_id=$3
    AND m.principal_id=$2 AND m.role='owner' FOR UPDATE OF a FOR SHARE OF x,m`,[input.accountId,principal,projectId])).rows[0];
   if(!account)throw new Refusal('ACCOUNT_FORBIDDEN',403);
   if(!modeCompatible(account.mode,input))throw new Refusal('PROVIDER_ELIGIBILITY_MODE_MISMATCH');
   const hash=digest({principal,projectId,input,provider:account.provider,mode:account.mode});
   const latest=(await c.query('SELECT COALESCE(max(revision),0)::int revision FROM ac_provider_eligibility_assessments WHERE account_id=$1',[input.accountId])).rows[0].revision as number;
   if(latest!==input.expectedRevision){
    const old=(await c.query(`SELECT ${projection} FROM ac_provider_eligibility_assessments e JOIN ac_accounts a ON a.id=e.account_id
     WHERE e.account_id=$1 AND e.revision=$2`,[input.accountId,input.expectedRevision+1])).rows[0];
    if(old?.request_digest===hash){const verified=projectRow(old);
     return {revision:verified.revision,duplicate:true,reviewedAt:verified.reviewedAt,expiresAt:verified.expiresAt};}
    throw new Refusal('PROVIDER_ELIGIBILITY_REVISION_CONFLICT');
   }
   const allowed=(await c.query(`SELECT $1::timestamptz<=clock_timestamp()+interval '60 seconds' AND
    $1::timestamptz>=clock_timestamp()-interval '30 days' allowed`,[input.reviewedAt])).rows[0].allowed;
   if(!allowed)throw new Refusal('PROVIDER_ELIGIBILITY_REVIEW_TIME_INVALID');
   const row=(await c.query(`INSERT INTO ac_provider_eligibility_assessments(account_id,revision,project_id,principal_id,request_digest,request_snapshot,provider,account_mode,
    plan,adapter_id,adapter_version,authentication_mode,execution_mode,source_url,status,reason,reviewed_at,valid_for_seconds,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$17::timestamptz+$18::int*interval '1 second')
    RETURNING revision,reviewed_at,expires_at`,[input.accountId,input.expectedRevision+1,projectId,principal,hash,input,account.provider,account.mode,
     input.plan,input.adapterId,input.adapterVersion,input.authenticationMode,input.executionMode,input.sourceURL,input.status,input.reason,input.reviewedAt,input.validForSeconds])).rows[0];
   return {revision:row.revision,duplicate:false,reviewedAt:(row.reviewed_at as Date).toISOString(),expiresAt:(row.expires_at as Date).toISOString()};
  });
 }
 async view(principal:string,projectId:string,accountId:string,limit=20){
  Id.parse(projectId);Id.parse(accountId);z.number().int().min(1).max(100).parse(limit);
  return this.tx(async c=>{
   const rows=(await c.query(`WITH authorized AS (
     SELECT EXISTS(SELECT 1 FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id
      JOIN ac_memberships m ON m.project_id=x.project_id WHERE a.id=$1 AND x.project_id=$2 AND m.principal_id=$3) allowed
    ) SELECT authorized.allowed,history.* FROM authorized LEFT JOIN LATERAL (
     SELECT ${projection} FROM ac_provider_eligibility_assessments e JOIN ac_accounts a ON a.id=e.account_id
     WHERE authorized.allowed AND e.account_id=$1 ORDER BY e.revision DESC LIMIT $4
    ) history ON true`,[accountId,projectId,principal,limit])).rows;
   if(!rows[0]?.allowed)throw new Refusal('ACCOUNT_FORBIDDEN',403);
   const history=rows.filter(row=>row.account_id!==null).map(projectRow);
   return {accountId,latest:history[0]??null,history};
  });
 }
 async viewProject(principal:string,projectId:string,limit=100){
  Id.parse(projectId);z.number().int().min(1).max(100).parse(limit);
  return this.tx(async c=>{
   const rows=(await c.query(`WITH authorized AS (
     SELECT EXISTS(SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2) allowed
    ) SELECT authorized.allowed,latest.* FROM authorized LEFT JOIN LATERAL (
     SELECT DISTINCT ON (e.account_id) ${projection} FROM ac_provider_eligibility_assessments e JOIN ac_accounts a ON a.id=e.account_id
     JOIN ac_account_access x ON x.account_id=e.account_id AND x.project_id=$1
     WHERE authorized.allowed ORDER BY e.account_id,e.revision DESC LIMIT $3
    ) latest ON true`,[projectId,principal,limit+1])).rows;
   if(!rows[0]?.allowed)throw new Refusal('PROJECT_FORBIDDEN',403);
   const data=rows.filter(row=>row.account_id!==null);
   const assessments=data.slice(0,limit).map(projectRow);
   return {assessments,truncated:data.length>limit};
  });
 }
}
