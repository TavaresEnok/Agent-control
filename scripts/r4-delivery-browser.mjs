// Actual product component, gateway and BrowserSessions; real disposable Happier/PG/SSH.
// Manager authority is the live fixture Ledger lease, not server-main's registry.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {serve} from '@hono/node-server';
import nacl from 'tweetnacl';
import {chromium} from '../upstream/cezar/node_modules/playwright-core/index.mjs';
import {createServer} from '../upstream/cezar/node_modules/vite/dist/node/index.js';
import {RecoveryHappier} from '../tests/fixtures/r3-happier-recovery.ts';
import {remoteDevelopmentLab} from '../tests/fixtures/r3-delivery-lab.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {createProjectAdminApi} from '../src/project-admin-api.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {configuredRemoteDevelopment} from '../src/remote-development-config.ts';
import {BrowserSessions} from '../src/sessions.ts';
import {Operators} from '../src/operator.ts';
process.umask(0o077);
const root=resolve(import.meta.dirname,'..'),web=join(root,'upstream/cezar/packages/web');
const area=await mkdtemp('/tmp/ac-r4-delivery-browser-');
const happier=new RecoveryHappier(join(area,'happier'),join(area,'home'));
let lab,browser,vite,gateway,sessions,stage='setup';
try{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 await happier.start();
 const pair=nacl.sign.keyPair.fromSeed(randomBytes(32)),challenge=randomBytes(32),b64=bytes=>Buffer.from(bytes).toString('base64');
 const response=await fetch(happier.origin+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))})});assert.equal(response.status,200);
 const {token}=await response.json(),authorization='Bearer '+token;
 const profile=await (await fetch(happier.origin+'/v1/account/profile',{headers:{authorization}})).json();assert.equal(typeof profile.id,'string');
 lab=await remoteDevelopmentLab(base,{principal:profile.id});
 await mkdir(join(lab.root,'private'),{mode:0o700});const keyFile=join(lab.root,'private/verifier.key');await writeFile(keyFile,lab.verifierKey,{mode:0o600});
 const host=(await lab.db.pool.query('SELECT * FROM ac_remote_hosts WHERE id=$1',[lab.hostId])).rows[0];
 const provider=configuredRemoteDevelopment(lab.db,{mode:'synthetic-fixed-task-v1',transport:{allowedHosts:['127.0.0.1'],credentials:[{id:host.credential_ref,path:join(lab.root,'controller')}]},projects:[{projectId:lab.projectId,verifierKeyFile:keyFile,tmpfsRoot:lab.scratch,profiles:[{profileId:lab.profiles.programmer,hostId:lab.hostId,taskId:'implement',writePaths:['src/example.ts']}]}]},()=>lab.authority);
 const admin=new ProjectAdmin(lab.db,[{id:'fixture',label:'Disposable',path:lab.root}],join(lab.root,'private'),{remoteDevelopment:provider});
 const api=createProjectGateway({projects:{},runtimes:{},defaultProjectId:lab.projectId,appFor:()=>{throw Error('UNEXPECTED_RUNTIME');},publicFetch:async()=>new Response('Not found',{status:404}),authenticate:async request=>{sessions.checkOrigin(request);return sessions.authenticate(request);},projectAdmin:createProjectAdminApi(admin)});
 await new Promise(ok=>{gateway=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  if(new URL(request.url).pathname==='/api/v1/ac/auth/session'&&request.method==='POST')return sessions.issue(request);
  return api(request);
 }},ok);});
 const target='http://127.0.0.1:'+gateway.address().port;
 const entry=join(area,'entry.tsx');
 await writeFile(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider,useQuery}from'@tanstack/react-query';import{AgentControlRemoteDevelopment,remoteDevelopmentViewSchema}from${JSON.stringify(join(web,'src/routes/settings/agent-control-remote-development.tsx'))};import{operatorIdentity}from${JSON.stringify(join(web,'src/routes/settings/agent-control-operator.ts'))};import${JSON.stringify(join(web,'src/styles/index.css'))};window.operatorIdentity=operatorIdentity;const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});function App(){const q=useQuery({queryKey:['ac-project-admin'],queryFn:async()=>{const r=await fetch('/api/v1/ac/project-admin',{credentials:'include'});if(!r.ok)throw Error('HTTP_'+r.status);return r.json();}});return q.data?<AgentControlRemoteDevelopment principalId={q.data.principalId} installationId={q.data.installationId} projectId=${JSON.stringify(lab.projectId)} view={remoteDevelopmentViewSchema.parse(q.data.remoteDevelopment)}/>:<p>{q.error?.message??'Carregando'}</p>};createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);`);
 vite=await createServer({configFile:join(web,'vite.config.ts'),server:{host:'127.0.0.1',port:0,proxy:{'/api':target},fs:{allow:[root,area]}},plugins:[{name:'remote-browser-fixture',configureServer(server){server.middlewares.use('/remote-lab',async(_req,res)=>{res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml('/remote-lab',`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`));});}}]});
 await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 sessions=new BrowserSessions(lab.db,randomBytes(32),async request=>{const bearer=request.headers.get('authorization');if(!bearer)return null;const r=await fetch(happier.origin+'/v1/account/profile',{headers:{authorization:bearer},signal:AbortSignal.timeout(3000)});if(!r.ok)return null;const p=await r.json();return typeof p.id==='string'?p.id:null;},{origin,secure:false,maxAgeSeconds:3600});
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:360,height:844},isMobile:true,hasTouch:true});context.setDefaultTimeout(20000);
 assert.equal((await context.request.get(origin+'/api/v1/ac/project-admin')).status(),401);
 assert.equal((await context.request.post(origin+'/api/v1/ac/auth/session',{headers:{authorization,origin}})).status(),200);
 const page=await context.newPage();page.on('pageerror',error=>console.error('BROWSER_ERROR',error.message));await page.goto(origin+'/remote-lab');
 await page.getByRole('button',{name:'Preparar workspace remoto',exact:true}).waitFor();
 const identity=await page.evaluate(principal=>window.operatorIdentity(principal),lab.principal);await new Operators(lab.db).enroll(lab.principal,lab.principal,identity.deviceId,identity.publicKey);
 const commands=[];page.on('request',request=>{if(request.url().endsWith('/remote-development')&&request.method()==='POST')commands.push(request.postDataJSON());});
 stage='prepare lost ACK';let lost=false;
 await page.route('**/api/v1/ac/project-admin/remote-development',async route=>{if(!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');}else await route.continue();});
 await page.getByRole('button',{name:'Preparar workspace remoto',exact:true}).click();await page.getByRole('alert').waitFor();
 await page.reload();await page.getByRole('button',{name:'Confirmar pedido remoto pendente',exact:true}).click();await page.getByText('Pedido remoto confirmado. O artefato continua não revisado.',{exact:true}).waitFor();
 assert.equal(commands[0].intentId,commands[1].intentId);assert.deepEqual(commands[0].payload,commands[1].payload);assert.notEqual(commands[0].deliveryAttemptId,commands[1].deliveryAttemptId);
 stage='launch';await page.getByRole('button',{name:'Executar tarefa remota configurada',exact:true}).click();await page.getByRole('button',{name:'Registrar artefato remoto',exact:true}).waitFor();
 stage='register';await page.getByRole('button',{name:'Registrar artefato remoto',exact:true}).click();
 for(let i=0;i<60;i++){
  if(await page.getByTestId('ac-remote-workspace').getByText(/artefato registrado, não revisado/).count())break;
  const retry=page.getByRole('button',{name:'Confirmar pedido remoto pendente',exact:true});if(await retry.count()&&await retry.isEnabled())await retry.click();await page.waitForTimeout(500);
 }
 await page.getByTestId('ac-remote-workspace').getByText(/artefato registrado, não revisado/).waitFor();
 const artifact=(await lab.db.pool.query('SELECT * FROM ac_artifacts')).rows;assert.equal(artifact.length,1);assert.equal((await lab.db.pool.query('SELECT count(*)::int n FROM ac_verification_evidence')).rows[0].n,0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 console.log(JSON.stringify({proof:'r4-product-remote-browser',auth:'actual Happier Ed25519 token + BrowserSessions cookie',component:'actual product component',gateway:'actual signed project gateway',sshDocker:true,viewport:360,lostAckRecovered:true,sameIntent:true,artifactCount:1,reviewStatus:'not_reviewed',manager:'live Ledger fixture lease; server-main registry excluded',operatorEnrollment:'fixture Operators.enroll of browser nonextractable key',canonicalFullRoute:false}));
}catch(error){console.error('R4_BROWSER_STAGE',stage);throw error;}finally{
 const errors=[];for(const cleanup of [()=>browser?.close(),()=>vite?.close(),()=>new Promise(ok=>gateway?gateway.close(ok):ok()),()=>happier.stop(),()=>lab?.close(),()=>rm(area,{recursive:true,force:true})])try{await cleanup();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'R4_BROWSER_CLEANUP_FAILED');
}
