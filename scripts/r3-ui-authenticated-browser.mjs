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
import {loadHappier} from '../src/happier.ts'
import {Operators} from '../src/operator.ts'
import {provisionCapacity} from '../tests/fixtures/provision-capacity.ts'
import {initializeInstallation} from '../src/installation.ts'
process.umask(0o077)
const root=resolve(import.meta.dirname,'..'),lab=`ac-r3-ui-${randomUUID().slice(0,8)}`
let scratch,browser,gateway,happier,db,container=false,stage='setup',activePage,diagnosticRows=0
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
 const pgPort=await port(),hPort=await port(),gatewayPort=await port(),origin=`http://127.0.0.1:${gatewayPort}`,hOrigin=`http://127.0.0.1:${hPort}`
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
 const encryptionKey=pair.secretKey.subarray(0,32),native=await loadHappier(),seal=value=>native.encodeBase64(native.encrypt(encryptionKey,'legacy',value)),machineId=randomUUID()
 const machineResponse=await fetch(hOrigin+'/v1/machines',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({id:machineId,metadata:seal({host:'ac-r3-ui-disposable',platform:'linux',happyCliVersion:'0.2.18',homeDir:'/tmp/ac-r3-synthetic'}),daemonState:seal({status:'running',startedAt:Date.now()})})});assert.equal(machineResponse.status,200)
 const sessionResponse=await fetch(hOrigin+'/v1/sessions',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({tag:lab,encryptionMode:'e2ee',metadata:seal({machineId,path:'/tmp/ac-r3-synthetic/repository',host:'ac-r3-ui-disposable',homeDir:'/tmp/ac-r3-synthetic',version:'0.2.18',name:'R3 synthetic browser conversation',flavor:'codex',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})});assert.equal(sessionResponse.status,200)
 const {session}=await sessionResponse.json();assert.equal(typeof session.id,'string')
 stage='installation';const projectsRoot=join(scratch,'projects');await mkdir(projectsRoot,{mode:0o700})
 const makeRepo=async name=>{const repo=join(projectsRoot,name);await mkdir(repo,{mode:0o700});command('git',['init','-q','-b','main',repo]);command('git',['-C',repo,'config','user.email','fixture@example.invalid']);command('git',['-C',repo,'config','user.name','R3 synthetic lab']);await writeFile(join(repo,'README.md'),'Synthetic R3 UI lab only\n');await mkdir(join(repo,'src'));await writeFile(join(repo,'src','fixture.txt'),'synthetic tracked directory\n');command('git',['-C',repo,'add','.']);command('git',['-C',repo,'commit','-qm','synthetic base']);command('git',['-C',repo,'branch','protected']);await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[]}));return repo}
 const project={id:randomUUID(),label:'R3 synthetic mobile',repo:await makeRepo('first'),owner:profile.id};await makeRepo('second')
 const config={schemaVersion:1,mode:'administration-only',databaseUrl:database,dataDirectory:join(scratch,'private'),project,projects:[],projectRoots:[{id:'lab',label:'R3 disposable repositories',path:projectsRoot}],http:{listen:'127.0.0.1',port:gatewayPort,publicOrigin:origin},happier:{upstreamOrigin:hOrigin,webOrigin:hOrigin,publicServerOrigin:hOrigin},sessionMaxAgeSeconds:3600}
 db=new Ledger(database);await initializeInstallation(config,db);await provisionCapacity(db,profile.id,project.id)
 const domainId=randomUUID(),oldInstallationId=randomUUID(),newInstallationId=randomUUID();await new InstallationAuthority(db).initializeLaboratory(profile.id,{domainId,label:'R3 disposable UI authority',oldInstallationId,newInstallationId,mode:'synthetic-laboratory'})
 const file=join(scratch,'installation.json');await writeFile(file,JSON.stringify(config),{mode:0o600})
 async function startGateway(){gateway=await child(['--import','tsx','src/server-main.ts','serve',file],{cwd:root});await wait(async()=>{if(gateway.exitCode!==null)throw Error('GATEWAY_EXIT');return (await fetch(origin+'/api/v1/ac/auth/config')).ok},'GATEWAY_READY')}
 await startGateway();browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']})
 if(process.env.AC_R3_UI_RESTART_LINK_ONLY==='1'){
  for(let attempt=1;attempt<=4;attempt++){
   stage=`isolated restart/link ${attempt}`;await stop(gateway);await startGateway()
   const client=await browser.newContext({viewport:{width:attempt%2?360:390,height:844},isMobile:true,hasTouch:true});client.setDefaultTimeout(10000);const page=await client.newPage();activePage=page
   await page.goto(`${origin}/p/${project.id}/settings/agent-control`);await page.getByRole('button',{name:'Entrar pelo Happier',exact:true}).waitFor()
   assert.equal((await client.request.post(origin+'/api/v1/ac/auth/session',{headers:{authorization,origin}})).status(),200);assert.equal((await client.request.get(origin+'/api/v1/ac/auth/status')).status(),200)
   await page.reload();await page.getByLabel('Identificador da sessão Happier',{exact:true}).fill(session.id)
   const linked=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/contexts')&&r.request().method()==='POST');await page.getByRole('button',{name:'Vincular conversa',exact:true}).click();assert.equal((await linked).status(),201);await page.getByRole('button',{name:/Pausar novas etapas|Retomar etapas/}).waitFor()
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_contexts')).rows[0].n,1);await client.close();console.log(`PASS isolated fresh browser authentication/link after real gateway restart ${attempt}/4`)
  }
 }else for(const width of [360,390]){
  stage=`authenticated product ${width}`
  const client=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true}),page=await client.newPage();client.setDefaultTimeout(10000);activePage=page;page.on('response',async response=>{const url=new URL(response.url());if(url.origin===origin&&url.pathname.startsWith('/api/')&&response.status()>=400){const value=await response.json().catch(()=>null);const error=typeof value?.error==='string'&&/^[A-Z_0-9]{1,100}$/.test(value.error)?value.error:'redacted';console.log(`HTTP_REFUSAL ${response.status()} ${url.pathname} ${error}`)}})
  for(const path of ['/api/v1/ac/contexts','/api/v1/ac/project-admin','/api/v1/ac/quota-registry','/api/v1/ac/installation-authority?domainId='+domainId])assert.equal((await client.request.get(origin+path)).status(),401)
  stage='open product';await page.goto(`${origin}/p/${project.id}/settings/agent-control`);await page.getByText('Entrar pelo Happier',{exact:true}).waitFor()
  assert.equal((await client.request.post(origin+'/api/v1/ac/auth/session',{headers:{authorization,origin}})).status(),200)
  stage=`verify issued session ${width}`;assert.equal((await client.request.get(origin+'/api/v1/ac/auth/status')).status(),200)
  stage=`load authenticated settings ${width}`;await page.reload();await page.getByLabel('Identificador da sessão Happier',{exact:true}).waitFor();stage=`fill existing conversation ${width}`;await page.getByLabel('Identificador da sessão Happier',{exact:true}).fill(session.id);stage=`link existing conversation ${width}`;const linked=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/contexts')&&r.request().method()==='POST');await page.getByRole('button',{name:'Vincular conversa',exact:true}).click();assert.equal((await linked).status(),201);stage=`show linked conversation ${width}`;await page.getByRole('button',{name:/Pausar novas etapas|Retomar etapas/}).waitFor()
  const contexts=await (await client.request.get(origin+'/api/v1/ac/contexts',{headers:{'X-Agent-Control-Project':project.id}})).json();assert.equal(contexts.contexts.length,width===390&&process.env.AC_R3_UI_DIAGNOSTIC_CATALOG==='1'?2:1);const contextId=contexts.contexts.find(context=>context.session_id===session.id).id
  if(width===360){
   if(process.env.AC_R3_UI_DIAGNOSTIC_CATALOG==='1'){
    stage='diagnostic task catalog';const taskIds=Array.from({length:101},()=>randomUUID());diagnosticRows=taskIds.length
    for(const [index,id] of taskIds.entries())await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state,created_at) VALUES($1,$2,$3,$4,'{}',$5,$6,1,$7,'failed',$8)`,[id,contextId,profile.id,'a'.repeat(64),randomUUID(),randomUUID(),index+1,index===0?'2002-01-01T00:00:00Z':'2001-01-01T00:00:00Z'])
    const defaultReport=await (await client.request.get(`${origin}/api/v1/ac/contexts/${contextId}/diagnostics`,{headers:{'X-Agent-Control-Project':project.id}})).json();assert(defaultReport.truncated);assert(!defaultReport.findings.some(finding=>finding.evidence.some(evidence=>evidence.id===taskIds[0])))
    await page.reload();const selector=page.getByLabel('Tarefa registrada para diagnóstico',{exact:true});await selector.locator(`option[value="${taskIds[0]}"]`).waitFor({state:'attached'})
    const targeted=page.waitForResponse(r=>r.url().includes('/diagnostics?intentId='+taskIds[0]));await selector.selectOption(taskIds[0]);const response=await targeted;assert.equal(response.status(),200);const report=await response.json();assert.equal(report.intentId,taskIds[0]);assert(report.findings.some(finding=>finding.evidence.some(evidence=>evidence.id===taskIds[0])));await page.getByRole('status').filter({hasText:'Diagnóstico direcionado à tarefa '+taskIds[0]}).waitFor();await page.getByText('Responsável:',{exact:false}).first().waitFor();await page.getByText('Próxima condição:',{exact:false}).first().waitFor();await page.getByText('Responsável:',{exact:false}).first().locator('..').evaluate(element=>element.scrollIntoView({block:'start'}));await page.screenshot({path:join(root,'docs/validation/evidence/r4-ui-targeted-diagnostic-360.png')});const secondSessionResponse=await fetch(hOrigin+'/v1/sessions',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({tag:lab+'-diagnostic-scope',encryptionMode:'e2ee',metadata:seal({machineId,path:'/tmp/ac-r3-synthetic/second',host:'ac-r3-ui-disposable',name:'R4 diagnostic scope',flavor:'codex'}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})});assert.equal(secondSessionResponse.status,200);const secondSession=(await secondSessionResponse.json()).session;
    await page.getByLabel('Identificador da sessão Happier',{exact:true}).fill(secondSession.id);const secondLinked=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/contexts')&&r.request().method()==='POST');await page.getByRole('button',{name:'Vincular conversa',exact:true}).click();const secondLinkedResponse=await secondLinked;assert.equal(secondLinkedResponse.status(),201);const secondContext=(await secondLinkedResponse.json()).contextId;
    await page.getByLabel('Conversa',{exact:true}).selectOption(secondContext);await page.getByRole('heading',{name:'Diagnóstico da conversa',exact:true}).waitFor();await page.waitForFunction(()=>!document.body.textContent.includes('Diagnóstico direcionado à tarefa'));assert.equal(await page.getByLabel('Identificador da tarefa para diagnóstico',{exact:true}).inputValue(),'');assert.equal(await page.locator(`option[value="${taskIds[0]}"]`).count(),0);await page.getByLabel('Conversa',{exact:true}).selectOption(contextId);await page.getByLabel('Tarefa registrada para diagnóstico',{exact:true}).waitFor();console.log('PASS actual context switch clears targeted diagnostic selection and does not expose previous context task');console.log('PASS actual authorized task catalog selection reaches stopped task beyond default diagnostic page; 101 synthetic failed rows, zero execution workers')
   }
   stage='refuse unregistered operator';let response=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST');await page.getByRole('button',{name:'Pausar novas etapas',exact:true}).click();assert.equal((await response).status(),403)
   stage='operator bootstrap';const bootstrap=randomBytes(32).toString('hex');await new Operators(db).prepareBootstrap(profile.id,profile.id,bootstrap);await page.getByLabel('Código de ativação',{exact:true}).fill(bootstrap);await page.getByRole('button',{name:'Ativar este dispositivo',exact:true}).click();await page.getByText('Dispositivo autorizado.',{exact:true}).waitFor()
   if(process.env.AC_R3_UI_CONVERSATION_MENU==='1'){const {proveConversationMenu}=await import('./r3-ui-conversation-menu.mjs');const {popup}=await proveConversationMenu({browserContext:client,panelOrigin:origin,happierOrigin:hOrigin,sessionId:session.id,token,secret32base64:b64(encryptionKey),contextId,scratchDirectory:scratch});for(const name of ['Pausar novas etapas','Retomar etapas']){const response=popup.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST');await popup.getByRole('button',{name,exact:true}).click();assert.equal((await response).status(),200)}await popup.close();await page.reload();console.log('PASS canonical Happier conversation menu opens matching context and signs pause/resume through production panel')}
   if(process.env.AC_R3_UI_ENVIRONMENTS==='1'){stage='signed project environments';const {proveProjectEnvironments}=await import('./r4-ui-environments.mjs');await proveProjectEnvironments({page,client,origin,projectId:project.id,db,outputDirectory:join(root,'docs/validation/evidence'),restart:async()=>{await stop(gateway);await startGateway()}})}
   stage='signed laboratory authority'
   await page.getByLabel('Domínio de laboratório',{exact:true}).fill(domainId);await page.getByRole('button',{name:'Consultar autoridade',exact:true}).click();await page.getByRole('button',{name:'Retomar autoridade de laboratório',exact:true}).waitFor()
   await page.getByLabel('Instalação de destino',{exact:true}).selectOption(newInstallationId)
   let authorityResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/installation-authority')&&r.request().method()==='POST');await page.getByRole('button',{name:'Transferir autoridade de laboratório',exact:true}).click();assert.equal((await authorityResponse).status(),200)
   await page.getByRole('status').filter({hasText:'época 2'}).waitFor();await page.getByLabel('Instalação de destino',{exact:true}).selectOption(oldInstallationId)
   authorityResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/installation-authority')&&r.request().method()==='POST');await page.getByRole('button',{name:'Reverter autoridade ao destino',exact:true}).click();assert.equal((await authorityResponse).status(),200)
   await page.getByRole('status').filter({hasText:'época 3'}).waitFor()
   authorityResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/installation-authority')&&r.request().method()==='POST');await page.getByRole('button',{name:'Retomar autoridade de laboratório',exact:true}).click();assert.equal((await authorityResponse).status(),200)
   await page.getByRole('button',{name:'Pausar autoridade de laboratório',exact:true}).waitFor()
   const authority=(await db.pool.query('SELECT epoch,holder_installation_id,paused FROM ac_installation_domains WHERE id=$1',[domainId])).rows[0];assert.equal(Number(authority.epoch),3);assert.equal(authority.holder_installation_id,oldInstallationId);assert.equal(authority.paused,false)
   stage='signed project template'
   await page.getByLabel('Nome do template do projeto',{exact:true}).fill('R3 browser template')
   let templateResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST');await page.getByRole('button',{name:'Salvar fluxo atual como template do projeto',exact:true}).click();assert.equal((await templateResponse).status(),200)
   await page.getByRole('button',{name:'Reutilizar revisão 1',exact:true}).waitFor()
   templateResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST');await page.getByRole('button',{name:'Reutilizar revisão 1',exact:true}).click();assert.equal((await templateResponse).status(),200)
   const frozen=(await db.pool.query('SELECT t.snapshot,t.source_revision,p.snapshot AS original FROM ac_context_templates t JOIN ac_project_templates p ON p.project_id=t.source_project_id AND p.template_id=t.source_template_id AND p.revision=t.source_revision WHERE t.context_id=$1',[contextId])).rows;assert.equal(frozen.length,1);assert.equal(frozen[0].source_revision,1);assert.deepEqual(frozen[0].snapshot,frozen[0].original)
   stage='concurrent signed policy edits';const stale=await client.newPage();await stale.goto(`${origin}/p/${project.id}/settings/agent-control`)
   for(const tab of [page,stale]){await tab.getByLabel('Revisão para editar',{exact:true}).selectOption('1');await tab.getByRole('button',{name:'Carregar revisão',exact:true}).click()}
   await page.getByLabel('Programadores por conversa',{exact:true}).fill('2');await stale.getByLabel('Programadores por conversa',{exact:true}).fill('3')
   const firstPolicy=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST'),secondPolicy=stale.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST')
   await Promise.all([page.getByRole('button',{name:'Publicar nova revisão',exact:true}).click(),stale.getByRole('button',{name:'Publicar nova revisão',exact:true}).click()])
   const policyResponses=await Promise.all([firstPolicy,secondPolicy]);assert.deepEqual(policyResponses.map(value=>value.status()).sort(),[200,409]);const winner=policyResponses[0].status()===200?2:3
   await (policyResponses[0].status()===409?page:stale).getByRole('alert').filter({hasText:'POLICY_CONFLICT'}).waitFor();await stale.close();await page.getByLabel('Revisão para editar',{exact:true}).locator('option[value="2"]').waitFor({state:'attached'})
   stage='browser policy rollback';await page.getByLabel('Revisão para editar',{exact:true}).selectOption('1');await page.getByRole('button',{name:'Preparar reversão desta revisão',exact:true}).click()
   response=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST');await page.getByRole('button',{name:'Publicar reversão como nova revisão',exact:true}).click();assert.equal((await response).status(),200)
   const versions=(await db.pool.query('SELECT revision,snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision',[project.id])).rows;assert.deepEqual(versions.map(v=>v.snapshot.maxProgrammersPerContext),[10,winner,10]);assert.deepEqual(versions[0].snapshot,versions[2].snapshot)
   stage='signed pause';const started=performance.now();response=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().method()==='POST');await page.getByRole('button',{name:'Pausar novas etapas',exact:true}).click();assert.equal((await response).status(),200);const acceptMs=Math.round(performance.now()-started);await page.getByRole('button',{name:'Retomar etapas',exact:true}).waitFor();console.log(`LOCAL_METRIC signed pause acceptance_ms=${acceptMs} projection_ms=${Math.round(performance.now()-started)}; loopback synthetic sample only`)
   if(process.env.AC_R3_UI_LATENCY==='1'){const {measureBrowserLatency}=await import('./r3-ui-latency.mjs');await measureBrowserLatency({page,contextId,client,origin,projectId:project.id,output:join(root,'docs/validation/evidence/r3-ui-latency.json')})}
   assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[contextId])).rows[0].paused,true)
   stage='restart pause';await stop(gateway);await startGateway();await page.reload();await page.getByRole('button',{name:'Retomar etapas',exact:true}).waitFor()
   stage='register project';const adminCheck=await client.request.get(origin+'/api/v1/ac/project-admin',{headers:{'X-Agent-Control-Project':project.id}});const adminValue=await adminCheck.json();console.log(`ADMIN_CHECK status=${adminCheck.status()} canRegister=${adminValue.canRegister} roots=${adminValue.roots?.length} error=${adminValue.error??'none'}`);await page.getByLabel('Nome do projeto',{exact:true}).fill('R3 registered in mobile browser');await page.getByLabel('Raiz autorizada',{exact:true}).selectOption('lab');await page.getByLabel('Caminho relativo do repositório',{exact:true}).fill('second');response=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/project-admin')&&r.request().method()==='POST');await page.getByRole('button',{name:'Cadastrar projeto',exact:true}).click();assert.equal((await response).status(),200);await page.getByText('Projeto cadastrado.',{exact:true}).waitFor()
   stage='restart project';await stop(gateway);await startGateway();await page.reload();await page.getByRole('button',{name:'Retomar etapas',exact:true}).waitFor();const list=await (await client.request.get(origin+'/api/v1/projects')).json();assert(list.projects.some(p=>p.name==='R3 registered in mobile browser'))
  }
  stage=`usage report ${width}`
  const usageResponse=page.waitForResponse(r=>r.url().includes(`/api/v1/ac/contexts/${contextId}/usage/report?`)&&r.request().method()==='GET');await page.getByRole('button',{name:'Consultar relatório de uso',exact:true}).click();assert.equal((await usageResponse).status(),200);await page.getByRole('status').filter({hasText:'Esta página contém 0 tentativas.'}).waitFor()
  const csvResponse=page.waitForResponse(r=>r.url().includes('/usage/report.csv?')),downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Baixar CSV desta página',exact:true}).click();const [csv,download]=await Promise.all([csvResponse,downloadEvent]);assert.equal(csv.status(),200);assert.equal(await download.failure(),null);assert((await readFile(await download.path(),'utf8')).includes('page_complete'))
  await page.getByRole('status').filter({hasText:'Desabilitada; fontes registradas: 0.'}).waitFor()
  stage=`viewport ${width}`;const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert(geometry.scroll<=geometry.width+1);await page.getByRole('heading',{name:'Diagnóstico da conversa',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Diagnóstico da conversa',exact:true}).count(),1);await page.screenshot({path:join(root,`docs/validation/evidence/r3-ui-mobile-${width}.png`)})
  stage='logout';await page.getByRole('button',{name:'Sair deste navegador',exact:true}).click();await page.getByText('Entrar pelo Happier',{exact:true}).waitFor();assert.equal((await client.request.get(origin+'/api/v1/ac/contexts')).status(),401);await client.close()
  console.log(`PASS ${width}: canonical Happier token, production cookie/auth routes, conversation access, real usage JSON/CSV, disabled quota registry, mobile settings and logout${width===360?', signed refusal/bootstrap/authority/template/policy conflict/rollback/pause/register and persistence after two server restarts':''}`)
 }
 for(const table of ['ac_intents','ac_operations','ac_outbox','ac_capacity_grants'])assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,table==='ac_intents'?diagnosticRows:0)
 console.log('PASS no execution or inference; disposable synthetic lab only; physical Android not exercised')
}catch(error){if(scratch){const upstreamLog=await readFile(join(scratch,'0.log'),'utf8').catch(()=>'');console.error('R3_UI_UPSTREAM_RATE_LIMIT_RESPONSES '+(upstreamLog.match(/\"statusCode\": 429/g)||[]).length)}if(activePage)console.error('R3_UI_ALERTS '+JSON.stringify(await activePage.locator('[role=alert]').allTextContents().catch(()=>[])));console.error(`R3_UI_FAILED stage=${stage} type=${error?.name??'Error'} code=${error?.code??'assertion_or_timeout'}`);process.exitCode=1}
finally{
 const cleanupErrors=[]
 async function attempt(operation){try{await operation()}catch(error){cleanupErrors.push(error)}}
 await attempt(async()=>browser?.close())
 for(const c of children.reverse())await attempt(()=>stop(c))
 await attempt(async()=>db?.close())
 if(container)await attempt(async()=>{const label=command('docker',['inspect','-f','{{index .Config.Labels "org.agent-control.purpose"}}',lab]).toString().trim();assert.equal(label,'ac-r3-ui-disposable');command('docker',['rm','-f',lab])})
 if(scratch)await attempt(()=>rm(scratch,{recursive:true,force:true}))
 if(cleanupErrors.length){console.error(`R3_UI_CLEANUP_FAILED count=${cleanupErrors.length}; original result preserved`);process.exitCode=1}
}
