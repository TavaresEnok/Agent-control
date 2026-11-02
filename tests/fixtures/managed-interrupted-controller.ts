import {readFile,writeFile} from 'node:fs/promises';
import {Ledger} from '../../src/ledger.ts';
import {CezarRuntime} from '../../src/cezar.ts';
import {GitArtifacts} from '../../src/git.ts';
import {Quality} from '../../src/quality.ts';
import {IsolatedImplementation} from '../../src/isolated-implementation.ts';
import {SandboxClient} from '../../src/sandbox-client.ts';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
if(config.scope!=='managed-crash-fixture'||!process.env.AC_SANDBOX_DATABASE_URL?.includes('/ac_managed_test_'))throw Error('ISOLATED_FIXTURE_REQUIRED');
const ledger=new Ledger(process.env.AC_SANDBOX_DATABASE_URL),git=new GitArtifacts(config.repo),key=Buffer.from(config.verifierKey,'base64');
const client=new SandboxClient(),perform=client.perform.bind(client);
client.perform=async(...args)=>{
 const result=await perform(...args);
 if(config.stop==='physical'&&['start','reconcile'].includes(args[0])&&args[4]?.profile==='synthetic-implementation-v1'&&
    (result as {exitCode?:unknown}).exitCode===0){
  runtime.store.flush({throwOnError:true});await writeFile(config.marker,JSON.stringify({ready:true,jobId:args[1]}));
  await new Promise(()=>{});
 }
 return result;
};
if(config.stop==='cas'){
 const original=git.cas.bind(git);
 git.cas=async(...args)=>{const result=await original(...args);if(result.status!=='integrated')return result;runtime.store.flush({throwOnError:true});
  await writeFile(config.marker,JSON.stringify({ready:true}));await new Promise(()=>{});return result;};
}
const runtime=new CezarRuntime(ledger,config.repo,config.project,{git,quality:new Quality(ledger,key,git),verifierKey:key,
 qualityRevision:config.qualityRevision,targetRef:'refs/heads/protected'},new IsolatedImplementation(ledger,client));
await runtime.start();await runtime.dispatch(config.intent,config.authority);setInterval(()=>{},1000);
