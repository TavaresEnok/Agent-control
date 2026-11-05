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
import {projectRepositoryIdentity} from '../src/project-repository.ts'
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
 for(const p of [project,bootProject]){const id=await projectRepositoryIdentity(p.repo);await db.pool.query('INSERT INTO ac_project_repository_identity VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[p.id,id.repoDev,id.repoIno,id.gitDev,id.gitIno,'lab',projectsRoot,p.repo.split('/').pop()]);}

 const domainId=randomUUID(),oldInstallationId=randomUUID(),newInstallationId=randomUUID();await new InstallationAuthority(db).initializeLaboratory(profile.id,{domainId,label:'R3 disposable UI authority',oldInstallationId,newInstallationId,mode:'synthetic-laboratory'})
 const file=join(scratch,'installation.json');await writeFile(file,JSON.stringify(config),{mode:0o600})
 async function startGateway(){gateway=await child(['--import','tsx','src/server-main.ts','serve',file],{cwd:root});await wait(async()=>{if(gateway.exitCode!==null)throw Error('GATEWAY_EXIT');return (await fetch(origin+'/api/v1/ac/auth/config')).ok},'GATEWAY_READY')}
 await startGateway();browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']})
 stage='conversation browser';
 const client=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});client.setDefaultTimeout(20000);
 const page=await client.newPage();activePage=page;page.on('response',r=>{if(r.status()>=400||r.url().includes('workflow'))console.error('HTTP_SEEN',r.status(),r.request().method(),r.url())});
 assert.equal((await client.request.post(origin+'/api/v1/ac/auth/session',{headers:{authorization,origin}})).status(),200);
 await page.goto(`${origin}/settings/agent-control`);
 stage='device enrollment';
 const device=await page.evaluate(async principal=>{
  const pair=await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']);
  const bytes=new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey));
  const value={id:crypto.randomUUID(),privateKey:pair.privateKey,publicKey:btoa(String.fromCharCode(...bytes))};
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('agent-control-operator',1);req.onupgradeneeded=()=>req.result.createObjectStore('keys');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
  await new Promise((resolve,reject)=>{const tx=db.transaction('keys','readwrite');tx.objectStore('keys').put(value,'principal:'+principal);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
  return {id:value.id,publicKey:value.publicKey};
 },profile.id);
 await new Operators(db).enroll(profile.id,profile.id,device.id,device.publicKey);
 stage='actual workflow editor';
 for(const width of [360,390]){
  await page.setViewportSize({width,height:844});
  await page.goto(`${origin}/p/${project.id}/workflows`);
  await page.getByLabel('Workflow name').fill(`mobile-${width}`);
  await page.getByRole('button',{name:'Add node'}).click();
  await page.getByRole('button',{name:/One agent session/}).click();
  await page.getByLabel('name',{selector:'input',exact:true}).fill('Review');
  await page.getByRole('button',{name:'Close inspector'}).click();
  await page.getByRole('button',{name:'Close node palette'}).click();
  await page.getByLabel('work done destination').selectOption('agent');
  await page.getByLabel('agent done destination').selectOption('end');
  await page.getByLabel('agent failed destination').selectOption('end');
  const save=page.getByRole('button',{name:'Save',exact:true});await save.waitFor();await page.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save');return !!button&&!button.disabled},null,{timeout:15000}).catch(()=>{});
  if(!(await save.isEnabled()))throw Error('SAVE_DISABLED '+await page.locator('body').innerText());
  const attempts=[];const observe=req=>{if(req.url().endsWith('/api/v1/ac/workflow-graphs')&&req.method()==='POST')attempts.push(req.postDataJSON())};page.on('request',observe);
  let dropped=false;await page.route('**/api/v1/ac/workflow-graphs',async route=>{if(route.request().method()==='POST'&&!dropped){dropped=true;const result=await route.fetch();if(result.status()!==200){await route.fulfill({response:result});return}await route.abort('failed')}else await route.continue()});
  await save.click();await page.getByRole('button',{name:'Retomar salvamento pendente',exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'Retomar salvamento pendente',exact:true}).waitFor();
  const submitted=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/workflow-graphs')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Retomar salvamento pendente',exact:true}).click();
  const response=await submitted;assert.equal(response.status(),200);assert(response.request().headers()['x-ac-operator-proof']);
  assert.equal((await response.json()).revision,1);await page.unroute('**/api/v1/ac/workflow-graphs');page.off('request',observe);
  assert.equal(attempts.length,2);assert.equal(attempts[0].intentId,attempts[1].intentId);assert.notEqual(attempts[0].deliveryAttemptId,attempts[1].deliveryAttemptId);assert.deepEqual(attempts[0].payload,attempts[1].payload);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_workflow_graph_intents WHERE id=$1',[attempts[0].intentId])).rows[0].n,1);
  await page.waitForURL(`**/workflows/mobile-${width}`);
  await page.reload();await page.getByLabel('Workflow name').waitFor();
  assert.equal(await page.getByLabel('Workflow name').inputValue(),`mobile-${width}`);
  await page.getByRole('button',{name:'Edit agent',exact:true}).click();
  await page.getByLabel('name',{selector:'input',exact:true}).fill('Edited review');
  await page.getByRole('button',{name:'Close inspector'}).click();
  const saveAgain=page.getByRole('button',{name:'Save',exact:true});
  await page.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save');return !!button&&!button.disabled},null,{timeout:15000});
  const second=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/workflow-graphs')&&r.request().method()==='POST');await saveAgain.click();
  const savedAgain=await second;assert.equal(savedAgain.status(),200);assert.equal((await savedAgain.json()).revision,2);
  await page.reload();await page.getByRole('button',{name:'Edit agent',exact:true}).click();
  assert.equal(await page.getByLabel('name',{selector:'input',exact:true}).inputValue(),'Edited review');
  await page.getByRole('button',{name:'Delete node',exact:true}).click();
  await page.getByLabel('work done destination').selectOption('end');
  await page.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save');return !!button&&!button.disabled},null,{timeout:15000});
  const third=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/workflow-graphs')&&r.request().method()==='POST');await saveAgain.click();
  const savedThird=await third;assert.equal(savedThird.status(),200);assert.equal((await savedThird.json()).revision,3);
  await page.reload();await page.getByLabel('Workflow name').waitFor();
  assert.equal(await page.getByRole('button',{name:'Edit agent',exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 }
 console.log('PASS actual product editor ACK-loss/reload/resume and create, edit, link, removal with three revisions at 360 and 390, synthetic Happier account, real BrowserSessions origin/cookie');
 await client.close();

}catch(error){if(scratch){const upstreamLog=await readFile(join(scratch,'0.log'),'utf8').catch(()=>'');console.error('R3_UI_UPSTREAM_RATE_LIMIT_RESPONSES '+(upstreamLog.match(/\"statusCode\": 429/g)||[]).length)}if(activePage){await activePage.screenshot({path:join(scratch,'failure.png'),fullPage:true}).catch(()=>{});console.error('R4_UI_BODY '+(await activePage.locator('body').innerText().catch(()=>'')).slice(0,1200))}if(activePage)console.error('R3_UI_ALERTS '+JSON.stringify(await activePage.locator('[role=alert]').allTextContents().catch(()=>[])));console.error(`R3_UI_FAILED stage=${stage} type=${error?.name??'Error'} code=${error?.code??'assertion_or_timeout'}`,error);process.exitCode=1}
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
