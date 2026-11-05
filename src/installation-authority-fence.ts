import type pg from 'pg';
import {Refusal} from './contracts.ts';
export type InstallationFenceToken={domainId:string;installationId:string;epoch:number};
/** Bound projects fail closed even when an old controller omits the new configuration. */
export async function fenceInstallationContext(c:pg.PoolClient,contextId:string,token?:InstallationFenceToken,allowPaused=false){
 const binding=(await c.query('SELECT domain_id FROM ac_installation_projects p JOIN ac_contexts x ON x.project_id=p.project_id WHERE x.id=$1',[contextId])).rows[0];
 if(!binding)return;
 const domain=(await c.query('SELECT holder_installation_id,epoch,paused FROM ac_installation_domains WHERE id=$1 FOR UPDATE',[binding.domain_id])).rows[0];
 if(!token||token.domainId!==binding.domain_id||token.installationId!==domain.holder_installation_id||token.epoch!==domain.epoch)throw new Refusal('STALE_INSTALLATION_AUTHORITY');
 if(domain.paused&&!allowPaused)throw new Refusal('INSTALLATION_PAUSED');
}
