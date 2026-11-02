// Isolated synthetic state used only by the backup/restore proof.
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Ledger} from '../../src/ledger.ts';
import {provisionCapacity} from './provision-capacity.ts';
import type {Command} from '../../src/contracts.ts';
const url=process.env.AC_TEST_DATABASE_URL;
if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
const db=new Ledger(url);await db.migrate();
try{
 const project=randomUUID(),principal='restore-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Restore sentinel']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const capacity=await provisionCapacity(db,principal,project),context=await db.createContext(principal,project,randomUUID());
 await capacity.service.assignPolicy(principal,context,capacity.revision);
 const authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
 const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
  action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:restore-sentinel'}};
 const intent=await db.accept(principal,command,authority,'api');
 const attempt=(await db.pool.query('SELECT execution_attempt_id FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0].execution_attempt_id;
 const grant=await capacity.service.reserve(principal,{attemptId:attempt,intentId:intent.id,contextId:context,role:'programmer'},authority);
 await capacity.service.transition(principal,grant.id,authority,'running');
 await capacity.service.transition(principal,grant.id,authority,'uncertain');
 await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2 WHERE id=$1",[intent.operation_id,grant.id]);
 await db.pause(principal,context,true);
 await writeFile('.state/backup-proof.json',JSON.stringify({scope:'isolated-restore-proof',context,grant:grant.id,account:grant.account_id}),{mode:0o600});
 console.log('Synthetic paused context and uncertain grant prepared. No worker launched.');
}finally{await db.close();}
