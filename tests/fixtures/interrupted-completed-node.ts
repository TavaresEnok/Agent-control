// Synthetic controller: stop after a saved stage receipt, before its native
// graph session settles. Config and verifier key remain in gitignored fixtures.
import {readFile,writeFile} from 'node:fs/promises';
import {Ledger} from '../../src/ledger.ts';
import {CezarRuntime} from '../../src/cezar.ts';
import {GitArtifacts} from '../../src/git.ts';
import {Quality} from '../../src/quality.ts';
import {Capacity} from '../../src/capacity.ts';
import {Integrator} from '../../src/integration.ts';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
if(config.scope!=='isolated-completed-node-recovery'||!process.env.AC_TEST_DATABASE_URL?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_FIXTURE_REQUIRED');
const ledger=new Ledger(process.env.AC_TEST_DATABASE_URL),git=new GitArtifacts(config.repo),key=Buffer.from(config.verifierKey,'base64');
const runtime=new CezarRuntime(ledger,config.repo,config.project,{git,quality:new Quality(ledger,key,git),verifierKey:key,
 qualityRevision:config.qualityRevision,targetRef:'refs/heads/protected'});
if(!runtime.engineering)throw Error('ENGINEERING_FIXTURE_REQUIRED');
const original=runtime.engineering.start.bind(runtime.engineering);
runtime.engineering.start=(...args)=>{
 if(args[2]==='qa'&&['qa-before-start','qa-wait-capacity'].includes(config.stopNode)){
  let inner:ReturnType<typeof original>|undefined;
  const result=(async()=>{
   if(config.stopNode==='qa-wait-capacity'){
    const row=(await ledger.pool.query('SELECT i.principal_id,g.account_id FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id JOIN ac_capacity_grants g ON g.id=o.grant_id WHERE i.id=$1',[config.intent.id])).rows[0];
    await new Capacity(ledger).observeQuota(row.principal_id,row.account_id,{status:'exhausted',source:'synthetic://interrupted-wait',ttlSeconds:3600});
    inner=original(...args);let failure:unknown;void inner.result.catch(error=>{failure=error;});
    let waiting=false;
    for(let i=0;i<100;i++){
     if(failure)throw failure;
     waiting=!!(await ledger.pool.query("SELECT 1 FROM ac_stage_operations s JOIN ac_capacity_waits w ON w.attempt_id=s.attempt_id WHERE s.intent_id=$1 AND s.node_id='qa' AND s.state='registered' AND w.reason='NO_ELIGIBLE_CAPACITY'",[config.intent.id])).rowCount;
     if(waiting)break;await new Promise(resolve=>setTimeout(resolve,25));
    }
    if(!waiting)throw Error('FIXTURE_DID_NOT_WAIT_FOR_CAPACITY');
   }
   runtime.store.flush({throwOnError:true});await writeFile(config.marker,JSON.stringify({ready:true,node:config.stopNode}));
   return new Promise<never>(()=>{});
  })();
  return {result,get open(){return true;},sendMessage:()=>false,end(){},interrupt(){inner?.interrupt();},hardStop(){inner?.hardStop?.();}};
 }
 const session=original(...args);
 if(args[2]!==config.stopNode||args[5])return session;
 return {result:session.result.then(async value=>{
  runtime.store.flush({throwOnError:true});await writeFile(config.marker,JSON.stringify({ready:true,node:config.stopNode}));
  await new Promise(()=>{});return value;
 }),get open(){return session.open;},get pid(){return session.pid;},sendMessage:()=>false,end:()=>session.end(),
 interrupt:()=>session.interrupt(),hardStop:()=>session.hardStop?.()};
};
if(config.stopNode==='integrate-registered'){
 Integrator.prototype.integrate=async()=>{
  runtime.store.flush({throwOnError:true});await writeFile(config.marker,JSON.stringify({ready:true,node:config.stopNode}));
  return new Promise<never>(()=>{});
 };
}
if(['integrate-after-cas','integrate-before-cas'].includes(config.stopNode)){
 const cas=git.cas.bind(git);git.cas=async(...args)=>{
  const receipt=config.stopNode==='integrate-after-cas'?await cas(...args):undefined;runtime.store.flush({throwOnError:true});
  await writeFile(config.marker,JSON.stringify({ready:true,node:config.stopNode}));
  await new Promise(()=>{});if(!receipt)throw Error('FIXTURE_WAS_RELEASED');return receipt;
 };
}
await runtime.start();await runtime.dispatch(config.intent,config.authority);
setInterval(()=>{},1000);
