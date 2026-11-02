// Configured administration gateway. No fixture, manager acquisition, dispatch
// loop or model adapter is started by this entrypoint.
import {serve} from '@hono/node-server';
import {z} from 'zod';
import {loadInstallation,sessionKey,initializeInstallation,prepareInstallationOperator} from './installation.ts';
import {Ledger} from './ledger.ts';
import {CezarRuntime} from './cezar.ts';
import {BrowserSessions} from './sessions.ts';
import {HappierAuthRelay} from './auth-relay.ts';
import {createApi} from './api.ts';
async function main(){
 const [command,path,...extra]=process.argv.slice(2);
 if(!path||extra.length||!['initialize','operator-bootstrap','serve'].includes(command))throw Error('USAGE: server-main initialize|operator-bootstrap|serve /absolute/private-config.json');
 const config=await loadInstallation(path),ledger=new Ledger(config.databaseUrl);
 let runtime:CezarRuntime|undefined,serving=false;
 try{
  if(command==='initialize'){console.log(JSON.stringify(await initializeInstallation(config,ledger)));return;}
  if(command==='operator-bootstrap'){console.log(JSON.stringify(await prepareInstallationOperator(config,ledger)));return;}
  // Serving does not silently migrate schemas or create projects/credentials.
  const registered=(await ledger.pool.query("SELECT 1 FROM ac_projects p JOIN ac_memberships m ON m.project_id=p.id WHERE p.id=$1 AND m.principal_id=$2 AND m.role='owner'",[config.project.id,config.project.owner])).rowCount;
  if(!registered)throw Error('INSTALLATION_NOT_INITIALIZED');
  const key=await sessionKey(config);
  const verify=async(request:Request)=>{
   const authorization=request.headers.get('authorization');if(!authorization?.startsWith('Bearer '))return null;
   try{
    const response=await fetch(config.happier.upstreamOrigin+'/v1/account/profile',{headers:{authorization},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)return null;return z.object({id:z.string().min(1).max(200)}).parse(await response.json()).id;
   }catch{return null;}
  };
  const sessions=new BrowserSessions(ledger,key,verify,{origin:config.http.publicOrigin,secure:config.http.publicOrigin.startsWith('https:'),maxAgeSeconds:config.sessionMaxAgeSeconds});key.fill(0);
  runtime=new CezarRuntime(ledger,config.project.repo,config.project.id);await runtime.start('administration-only');
  const access=async(principal:string,sessionId:string,request?:Request)=>request?
   sessions.verifyHappierSession(request,principal,sessionId,config.happier.upstreamOrigin):false;
  const api=createApi(ledger,runtime,verify,()=>undefined,config.happier.webOrigin,access,sessions,
   new HappierAuthRelay(sessions,{upstreamUrl:config.happier.upstreamOrigin,webUrl:config.happier.webOrigin,publicServerUrl:config.happier.publicServerOrigin}));
  const server=serve({fetch:api.fetch,hostname:config.http.listen,port:config.http.port},()=>console.log(JSON.stringify({state:'administration_ready',mode:config.mode,projectId:config.project.id,executionEnabled:false})));
  serving=true;
  let closing=false;
  const close=()=>{if(closing)return;closing=true;server.close();void runtime!.close().then(()=>ledger.close()).then(()=>process.exit(0));};
  process.once('SIGTERM',close);process.once('SIGINT',close);
 }finally{if(!serving){await runtime?.close();await ledger.close();}}
}
main().catch(()=>{console.error('INSTALLATION_COMMAND_FAILED: inspect private configuration, initialization and service availability; secrets are not logged.');process.exitCode=1;});
