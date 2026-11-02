// Synthetic child controller killed by the recovery test after the physical
// implementation completes, before its receipt reaches the Cezar graph.
import {readFile,writeFile} from 'node:fs/promises';
import {Ledger} from '../../src/ledger.ts';
import {CezarRuntime} from '../../src/cezar.ts';
import {SandboxClient} from '../../src/sandbox-client.ts';
import {IsolatedImplementation} from '../../src/isolated-implementation.ts';
import {GitArtifacts} from '../../src/git.ts';
import {Quality} from '../../src/quality.ts';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
if(config.scope!=='isolated-native-recovery'||!process.env.AC_SANDBOX_DATABASE_URL?.endsWith('/ac_sandbox_test'))throw Error('ISOLATED_FIXTURE_REQUIRED');
const ledger=new Ledger(process.env.AC_SANDBOX_DATABASE_URL),git=new GitArtifacts(config.repo),key=Buffer.from(config.verifierKey,'base64');
let runtime:CezarRuntime;
class InterruptedReceipt extends SandboxClient{
 override async perform(...args:Parameters<SandboxClient['perform']>){
  const value=await super.perform(...args);
  if(args[0]==='reconcile'&&(value as {exitCode?:number}).exitCode===0){
   runtime.store.flush({throwOnError:true});
   await writeFile(config.marker,JSON.stringify({physicalComplete:true,operationId:config.intent.operation_id}));
   await new Promise(()=>{});
  }
  return value;
 }
}
runtime=new CezarRuntime(ledger,config.repo,config.project,{git,quality:new Quality(ledger,key,git),verifierKey:key,
 qualityRevision:config.qualityRevision,targetRef:'refs/heads/protected'},new IsolatedImplementation(ledger,new InterruptedReceipt()));
await runtime.start();await runtime.dispatch(config.intent,config.authority);
setInterval(()=>{},1000);
