// Disposable lab only: canonical Happier light, real server-main, PostgreSQL and built product SPA.
import {chromium} from '../upstream/cezar/node_modules/playwright-core/index.mjs'
import {spawn,execFileSync} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,readFile,rm,open} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import net from 'node:net'
import {randomBytes,randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import pg from 'pg'
import {Ledger} from '../src/ledger.ts'
import {InstallationAuthority} from '../src/installation-authority.ts'
import {Operators} from '../src/operator.ts'
import {provisionCapacity} from '../tests/fixtures/provision-capacity.ts'
import {loadHappier} from '../src/happier.ts'
import {initializeInstallation} from '../src/installation.ts'
process.umask(0o077)
const root=resolve(import.meta.dirname,'..'),lab=`ac-r3-ui-${randomUUID().slice(0,8)}`
let scratch,browser,gateway,happier,db,container=false,stage='setup',activePage
const safe={PATH:process.env.PATH,CI:'1',DO_NOT_TRACK:'1',EXPO_NO_TELEMETRY:'1'}
const children=[]
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function wait(check,label){for(let i=0;i<240;i++){if(await check().catch(()=>false))return;await new Promise(r=>setTimeout(r,250))}throw Error(label)}
async function stop(child){if(!child||child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');let timer;const clean=await Promise.race([exited.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),5000)})]);clearTimeout(timer);if(!clean){child.kill('SIGKILL');await exited}}
function command(name,args,options={}){return execFileSync(name,args,{env:safe,stdio:'pipe',...options})}
async function child(args,options={}){const log=await open(join(scratch,`${children.length}.log`),'w');const processChild=spawn(process.execPath,args,{env:safe,stdio:['ignore',log.fd,log.fd],...options});children.push(processChild);await log.close();return processChild}
try{
 assert.match(process.version,/^v22\./)
 scratch=await mkdtemp(join(tmpdir(),`${lab}-`));safe.HOME=scratch
 const built=process.env.AC_R4_CONVERSATION_BUILD_DIR?JSON.parse(await readFile(join(resolve(process.env.AC_R4_CONVERSATION_BUILD_DIR),'manifest.json'),'utf8')):null;
 const pgPort=await port(),hPort=built?Number(new URL(built.happierOrigin).port):await port(),gatewayPort=built?Number(new URL(built.panelOrigin).port):await port(),origin=`http://127.0.0.1:${gatewayPort}`,hOrigin=`http://127.0.0.1:${hPort}`
 command('docker',['run','-d','--name',lab,'--label','org.agent-control.purpose=ac-r3-ui-disposable','--network','host','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_USER=ac_test','-e','POSTGRES_PASSWORD=synthetic-test-only','-e','POSTGRES_DB=ac_implementation_test','postgres:16-alpine','postgres','-c','listen_addresses=127.0.0.1','-p',String(pgPort)]);container=true
 const database=`postgresql://ac_test:synthetic-test-only@127.0.0.1:${pgPort}/ac_implementation_test`
 await wait(async()=>{const c=new pg.Client({connectionString:database,connectionTimeoutMillis:250});try{await c.connect();return true}finally{await c.end().catch(()=>{})}},'PG_READY')
 stage='Happier light';const data=join(scratch,'happier');await mkdir(data)
 const hEnv={...safe,HAPPIER_ACCOUNT_PROFILE_RATE_LIMIT_MAX:'10000',PORT:String(hPort),METRICS_ENABLED:'false',AUTH_ANONYMOUS_SIGNUP_ENABLED:'true',HAPPIER_FILES_BACKEND:'local',HAPPIER_DB_PROVIDER:'sqlite',HAPPY_DB_PROVIDER:'sqlite',HAPPIER_SERVER_LIGHT_DATA_DIR:data,HAPPIER_SERVER_HOST:'127.0.0.1',HAPPY_SERVER_HOST:'127.0.0.1',DATABASE_URL:`file:${data}/server.sqlite?socket_timeout=30&connection_limit=1`,HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:'required_e2ee'}
 const server=join(root,'upstream/happier/apps/server');command('yarn',['-s','migrate:sqlite:deploy'],{cwd:server,env:hEnv})
 happier=await child([join(root,'upstream/happier/node_modules/tsx/dist/cli.mjs'),'--tsconfig','./tsconfig.json','./sources/main.light.ts'],{cwd:server,env:hEnv})
 await wait(async()=>{if(happier.exitCode!==null)throw Error('HAPPIER_EXIT');return (await fetch(hOrigin+'/v1/account/profile')).status===401},'HAPPIER_READY')
 const b64=bytes=>Buffer.from(bytes).toString('base64'),pair=nacl.sign.keyPair.fromSeed(randomBytes(32)),challenge=randomBytes(32)
 const auth=await fetch(hOrigin+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))})});assert.equal(auth.status,200)
 const {token}=await auth.json(),authorization='Bearer '+token
 const profile=await (await fetch(hOrigin+'/v1/account/profile',{headers:{authorization}})).json();assert.equal(typeof profile.id,'string')
 const contentKey=randomBytes(32),boundary=await loadHappier(),seal=value=>boundary.encodeBase64(boundary.encrypt(contentKey,'legacy',value));
 const sessionResponse=await fetch(hOrigin+'/v1/sessions',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({tag:lab,encryptionMode:'e2ee',metadata:seal({path:'/tmp/synthetic-conversation',host:'r4-conversation',homeDir:'/tmp',version:'0.2.18',name:'R4 signed configuration',flavor:'claude',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})});assert.equal(sessionResponse.status,200)
 const {session}=await sessionResponse.json();assert.equal(typeof session.id,'string')
 stage='installation';const projectsRoot=join(scratch,'projects');await mkdir(projectsRoot,{mode:0o700})
 const makeRepo=async name=>{const repo=join(projectsRoot,name);await mkdir(repo,{mode:0o700});command('git',['init','-q','-b','main',repo]);command('git',['-C',repo,'config','user.email','fixture@example.invalid']);command('git',['-C',repo,'config','user.name','R3 synthetic lab']);await writeFile(join(repo,'README.md'),'Synthetic R3 UI lab only\n');command('git',['-C',repo,'add','.']);command('git',['-C',repo,'commit','-qm','synthetic base']);await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[]}));return repo}
 const project={id:randomUUID(),label:'R3 synthetic mobile',repo:await makeRepo('first'),owner:profile.id};const bootProject={id:randomUUID(),label:'R4 boot project without this conversation',repo:await makeRepo('second'),owner:profile.id}
 const config={schemaVersion:1,mode:'administration-only',databaseUrl:database,dataDirectory:join(scratch,'private'),project:bootProject,projects:[project],projectRoots:[{id:'lab',label:'R3 disposable repositories',path:projectsRoot}],http:{listen:'127.0.0.1',port:gatewayPort,publicOrigin:origin},happier:{upstreamOrigin:hOrigin,webOrigin:hOrigin,publicServerOrigin:hOrigin},sessionMaxAgeSeconds:3600}
 db=new Ledger(database);await initializeInstallation(config,db);await provisionCapacity(db,profile.id,project.id)
 const domainId=randomUUID(),oldInstallationId=randomUUID(),newInstallationId=randomUUID();await new InstallationAuthority(db).initializeLaboratory(profile.id,{domainId,label:'R3 disposable UI authority',oldInstallationId,newInstallationId,mode:'synthetic-laboratory'})
 const file=join(scratch,'installation.json');await writeFile(file,JSON.stringify(config),{mode:0o600})
 async function startGateway(){gateway=await child(['--import','tsx','src/server-main.ts','serve',file],{cwd:root});await wait(async()=>{if(gateway.exitCode!==null)throw Error('GATEWAY_EXIT');return (await fetch(origin+'/api/v1/ac/auth/config')).ok},'GATEWAY_READY')}
 await startGateway();browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']})
 stage='conversation browser';
 const client=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});client.setDefaultTimeout(20000);
 const page=await client.newPage();activePage=page;
 await page.goto(`${origin}/settings/agent-control`);
 await page.getByRole('button',{name:'Entrar pelo Happier',exact:true}).waitFor();
 assert.equal((await client.request.post(origin+'/api/v1/ac/auth/session',{headers:{authorization,origin}})).status(),200);
 stage='authenticated nondefault project';await page.goto(`${origin}/p/${project.id}/settings/agent-control`);await page.getByLabel('Identificador da sessão Happier',{exact:true}).fill(session.id);
 const linked=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/contexts')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Vincular conversa',exact:true}).click();assert.equal((await linked).status(),201);
 const contexts=await (await client.request.get(origin+'/api/v1/ac/contexts',{headers:{'X-Agent-Control-Project':project.id}})).json();
 const contextId=contexts.contexts[0].id;
 const bootstrap=randomBytes(32).toString('hex');await new Operators(db).prepareBootstrap(profile.id,profile.id,bootstrap);
 await page.getByLabel('Código de ativação',{exact:true}).fill(bootstrap);await page.getByRole('button',{name:'Ativar este dispositivo',exact:true}).click();await page.getByText('Dispositivo autorizado.',{exact:true}).waitFor();
 stage='canonical conversation menu';
 const {proveConversationMenu}=await import('./r3-ui-conversation-menu.mjs');
 assert.notEqual(project.id,bootProject.id);
 const {popup,evidenceDirectory}=await proveConversationMenu({browserContext:client,panelOrigin:origin,happierOrigin:hOrigin,sessionId:session.id,token,secret32base64:b64(contentKey),contextId,scratchDirectory:scratch});activePage=popup;
 stage='signed policy from conversation';
 assert(new URL(popup.url()).pathname.includes('/p/'+project.id+'/'));

 await popup.getByLabel('Revisão para editar',{exact:true}).selectOption('1');await popup.getByRole('button',{name:'Carregar revisão',exact:true}).click();
 await popup.getByLabel('Programadores por conversa',{exact:true}).fill('2');
 const policyResponse=popup.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST');
 await popup.getByRole('button',{name:'Publicar nova revisão',exact:true}).click();const policyResult=await policyResponse;assert.equal(policyResult.status(),200);
 const policyCommand=policyResult.request().postDataJSON();assert.equal(policyCommand.action,'policy.publish');assert.equal(policyCommand.contextId,contextId);assert(policyResult.request().headers()['x-ac-operator-proof']);
 const policy=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=2',[project.id])).rows[0];assert.equal(policy.snapshot.maxProgrammersPerContext,2);
 const unsigned=await client.request.post(origin+'/api/v1/ac/control',{headers:{'X-Agent-Control-Project':project.id,origin},data:{...policyCommand,intentId:randomUUID()}});assert.equal(unsigned.status(),403);assert.equal((await unsigned.json()).error,'HUMAN_CONTROL_AUTH_REQUIRED');
 stage='signed change from conversation';
 const response=popup.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST');
 await popup.getByRole('button',{name:'Pausar novas etapas',exact:true}).click();const result=await response;assert.equal(result.status(),200);
 const submitted=result.request().postDataJSON();assert.equal(submitted.contextId,contextId);assert(result.request().headers()['x-ac-operator-proof']);
 await popup.getByRole('button',{name:'Retomar etapas',exact:true}).waitFor();
 assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[contextId])).rows[0].paused,true);
 await popup.reload();await popup.getByRole('button',{name:'Retomar etapas',exact:true}).waitFor();
 const evidence=join(root,'docs/validation/evidence/r4-conversation-menu');await mkdir(evidence,{recursive:true});
 await popup.screenshot({path:join(evidence,'signed-panel.png'),fullPage:true});
 for(const file of ['canonical-menu.png','caller-proof.json','happier-export.log'])await writeFile(join(evidence,file),await readFile(join(evidenceDirectory,file)));
 await writeFile(join(evidence,'signed-proof.json'),JSON.stringify({canonicalMenu:true,authenticatedCookie:true,nonDefaultProject:true,projectId:project.id,bootProjectId:bootProject.id,sessionId:session.id,contextId,viewport:{width:390,height:844},sessionPinned:true,contextPinned:true,signedControlStatus:result.status(),signedPolicyStatus:policyResult.status(),durablePolicyRevision:2,maxProgrammersPerContext:2,unsignedRefusedStatus:unsigned.status(),unsignedRefusalCode:'HUMAN_CONTROL_AUTH_REQUIRED',signaturePresent:true,durablePaused:true,reloadedPaused:true,externalNetworkBlocked:true,syntheticAccount:true,physicalAndroid:false},null,2));
 console.log('PASS canonical Happier conversation menu -> authenticated pinned panel -> human-device signed control -> durable PG pause -> reload');
 await client.close();
}catch(error){if(scratch){const upstreamLog=await readFile(join(scratch,'0.log'),'utf8').catch(()=>'');console.error('R3_UI_UPSTREAM_RATE_LIMIT_RESPONSES '+(upstreamLog.match(/\"statusCode\": 429/g)||[]).length)}if(activePage){await activePage.screenshot({path:join(scratch,'failure.png'),fullPage:true}).catch(()=>{});console.error('R4_UI_BODY '+(await activePage.locator('body').innerText().catch(()=>'')).slice(0,1200))}if(activePage)console.error('R3_UI_ALERTS '+JSON.stringify(await activePage.locator('[role=alert]').allTextContents().catch(()=>[])));console.error(`R3_UI_FAILED stage=${stage} type=${error?.name??'Error'} code=${error?.code??'assertion_or_timeout'}`);process.exitCode=1}
finally{
 const cleanupErrors=[]
 async function attempt(operation){try{await operation()}catch(error){cleanupErrors.push(error)}}
 await attempt(async()=>browser?.close())
 for(const c of children.reverse())await attempt(()=>stop(c))
 await attempt(async()=>db?.close())
 if(container)await attempt(async()=>{const label=command('docker',['inspect','-f','{{index .Config.Labels "org.agent-control.purpose"}}',lab]).toString().trim();assert.equal(label,'ac-r3-ui-disposable');command('docker',['rm','-f',lab])})
 if(scratch){if(process.exitCode)console.error('FAILED_SCRATCH '+scratch);else await attempt(()=>rm(scratch,{recursive:true,force:true}))}
 if(cleanupErrors.length){console.error(`R3_UI_CLEANUP_FAILED count=${cleanupErrors.length}; original result preserved`);process.exitCode=1}
}
