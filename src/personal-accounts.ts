import type pg from 'pg';
import {join} from 'node:path';
import {Refusal} from './contracts.ts';
import {loginNotices,personalAccountRoot} from './personal-health.ts';
import {loadInstallation} from './installation.ts';

export type PersonalAccountStatus={id:string;provider:string;label:string;exhaustedUntil:string|null;login:string|null};

/** Accounts this project can use, with the quota pause and what the login file says. */
export async function personalAccountStatus(pool:pg.Pool,projectId:string,dataDirectory:string,installationPath:string,now=new Date()):Promise<PersonalAccountStatus[]>{
 const rows=(await pool.query(`SELECT a.id,a.provider,a.label,CASE WHEN a.exhausted_until>clock_timestamp() THEN a.exhausted_until END exhausted_until
  FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1 AND a.enabled AND a.mode='subscription_cli' ORDER BY a.provider,a.label`,[projectId])).rows;
 const accounts=rows.map(row=>({id:String(row.id),provider:String(row.provider)}));
 const root=await loadInstallation(installationPath).then(personalAccountRoot,()=>join(dataDirectory,'accounts'));
 const notices=await loginNotices(root,accounts,now,installationPath);
 return rows.map(row=>({id:String(row.id),provider:String(row.provider),label:String(row.label),
  exhaustedUntil:row.exhausted_until?new Date(row.exhausted_until).toISOString():null,
  login:notices.find(notice=>notice.key==='login:'+row.id)?.text??null}));
}

/** Ends a quota pause now. The next job may use the account again; if the provider is still out, the pause comes back. */
export async function releasePersonalAccount(pool:pg.Pool,projectId:string,accountId:string){
 const updated=await pool.query(`UPDATE ac_accounts a SET exhausted_until=NULL WHERE a.id=$1 AND a.mode='subscription_cli'
  AND EXISTS(SELECT 1 FROM ac_account_access x WHERE x.account_id=a.id AND x.project_id=$2) RETURNING a.id`,[accountId,projectId]);
 if(!updated.rowCount)throw new Refusal('ACCOUNT_NOT_FOUND',404);
}
