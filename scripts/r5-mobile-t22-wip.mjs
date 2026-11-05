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
import {Capacity} from '../src/capacity.ts'
import {provisionCapacity} from '../tests/fixtures/provision-capacity.ts'
import {loadHappier} from '../src/happier.ts'
import {initializeInstallation} from '../src/installation.ts'
import {ContextVault} from '../src/context-vault.ts'
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts'
import {ManagerPlans} from '../src/planning.ts'
import {digest} from '../src/contracts.ts'
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
 const machineId=randomUUID();const machine=await fetch(hOrigin+'/v1/machines',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({id:machineId,metadata:seal({host:'r5-mobile-synthetic',platform:'linux',happyCliVersion:'0.2.18',homeDir:scratch}),daemonState:seal({status:'running',startedAt:Date.now()})})});assert.equal(machine.status,200);
 const sessionResponse=await fetch(hOrigin+'/v1/sessions',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({tag:lab,encryptionMode:'e2ee',metadata:seal({machineId,path:'/tmp/synthetic-conversation',host:'r4-conversation',homeDir:'/tmp',version:'0.2.18',name:'R4 signed configuration',flavor:'claude',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})});assert.equal(sessionResponse.status,200)
 const {session}=await sessionResponse.json();assert.equal(typeof session.id,'string')
 stage='installation';const projectsRoot=join(scratch,'projects');await mkdir(projectsRoot,{mode:0o700})
 const makeRepo=async name=>{const repo=join(projectsRoot,name);await mkdir(repo,{mode:0o700});command('git',['init','-q','-b','main',repo]);command('git',['-C',repo,'config','user.email','fixture@example.invalid']);command('git',['-C',repo,'config','user.name','R3 synthetic lab']);await writeFile(join(repo,'README.md'),'Synthetic R3 UI lab only\n');command('git',['-C',repo,'add','.']);command('git',['-C',repo,'commit','-qm','synthetic base']);await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[]}));return repo}
 const project={id:randomUUID(),label:'R3 synthetic mobile',repo:await makeRepo('first'),owner:profile.id};const bootProject={id:randomUUID(),label:'R4 boot project without this conversation',repo:await makeRepo('second'),owner:profile.id}
 const config={schemaVersion:1,mode:'administration-only',databaseUrl:database,dataDirectory:join(scratch,'private'),project:project,projects:[bootProject],projectRoots:[{id:'lab',label:'R3 disposable repositories',path:projectsRoot}],http:{listen:'127.0.0.1',port:gatewayPort,publicOrigin:origin},happier:{upstreamOrigin:hOrigin,webOrigin:hOrigin,publicServerOrigin:hOrigin},sessionMaxAgeSeconds:3600}
 db=new Ledger(database);await initializeInstallation(config,db);await provisionCapacity(db,profile.id,project.id);await new Capacity(db).registerModel('synthetic-capacity-administrator',{provider:'synthetic',model:'mobile-worker-v1',efforts:['medium','high'],roles:['programmer'],source:'synthetic://mobile-lab'});await new Capacity(db).registerModel('synthetic-capacity-administrator',{provider:'synthetic',model:'mobile-review-v2',efforts:['high'],roles:['reviewer'],source:'synthetic://mobile-lab'})
 for(const p of [project,bootProject]){const id=await projectRepositoryIdentity(p.repo);await db.pool.query('INSERT INTO ac_project_repository_identity VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[p.id,id.repoDev,id.repoIno,id.gitDev,id.gitIno,'lab',projectsRoot,p.repo.split('/').pop()]);}

 const legacyAccount=randomUUID(),legacyProfiles=[randomUUID(),randomUUID(),randomUUID()];
 const legacyCapacity=new Capacity(db);await legacyCapacity.addAccount(profile.id,project.id,{id:legacyAccount,provider:'synthetic',label:'Synthetic legacy policy',resourceIdentity:'synthetic-legacy-'+legacyAccount,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://legacy',maxConcurrent:1});
 await legacyCapacity.observeQuota(profile.id,legacyAccount,{status:'available',source:'synthetic://legacy',ttlSeconds:3600});
 await db.pool.query("INSERT INTO ac_model_catalog VALUES('synthetic','OpenAI/GPT-6-ASTRA',ARRAY['medium'],ARRAY['programmer'],'synthetic://legacy')");
 await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$4,'OpenAI/GPT-6-ASTRA','medium','programmer',true),($2,$4,'fixed-worker-v1','high','programmer',true),($3,$4,'fixed-worker-v1','medium','programmer',true)",[...legacyProfiles,legacyAccount]);
 const contextId=await db.createContext(profile.id,project.id,session.id);
 await new Capacity(db).assignPolicy(profile.id,contextId,1);
 await new ContextKeys(db).authorize(profile.id,contextId,1,'legacy',keyFingerprint(contentKey),{sessionId:session.id});
 const vaultDir=join(scratch,'private','vault'),masterFile=join(scratch,'private','vault-master'),tokenFile=join(scratch,'private','manager-token');
 await mkdir(vaultDir,{mode:0o700});await writeFile(masterFile,randomBytes(32),{mode:0o600});await writeFile(tokenFile,token,{mode:0o600});
 const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton')).rows[0].id;
 const keyRequest={principal:profile.id,contextId,sessionId:session.id,profileId:'r5-mobile-manager',keyVersion:1,encryptionVariant:'legacy'};
 await new ContextVault(db,installationId,vaultDir,masterFile,[project.repo,bootProject.repo]).importKey(keyRequest,contentKey);
 config.contextVault={directory:vaultDir,masterFile};config.managerTransport={principal:profile.id,tokenFile,machineId,contexts:[{projectId:project.id,contextId,sessionId:session.id,profileId:'r5-mobile-manager',keyVersion:1,encryptionVariant:'legacy'}]};
 const quality={schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)};
 await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[project.id,quality,digest(quality)]);
 const domainId=randomUUID(),oldInstallationId=randomUUID(),newInstallationId=randomUUID();await new InstallationAuthority(db).initializeLaboratory(profile.id,{domainId,label:'R3 disposable UI authority',oldInstallationId,newInstallationId,mode:'synthetic-laboratory'})
 const file=join(scratch,'installation.json');await writeFile(file,JSON.stringify(config),{mode:0o600})
 async function startGateway(){gateway=await child(['--import','tsx','src/server-main.ts','serve',file],{cwd:root});await wait(async()=>{if(gateway.exitCode!==null)throw Error('GATEWAY_EXIT');return (await fetch(origin+'/api/v1/ac/auth/config')).ok},'GATEWAY_READY')}
 await startGateway();
 const live=(await db.pool.query('SELECT instance_id,epoch FROM ac_managers WHERE context_id=$1 AND lease_until>clock_timestamp()',[contextId])).rows[0];assert(live);
 const authority={contextId,instanceId:live.instance_id,epoch:Number(live.epoch)};
 const plan={schemaVersion:1,contextId,objectiveRef:'message:objective',sourceMessageRef:'message:fixture',constraintRefs:[],tasks:[{id:'fixture',objectiveRef:'message:fixture',acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:['output:fixture'],dependsOn:[],writePaths:['src/fixture'],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0}]};
 await new ManagerPlans(db).publish(profile.id,authority,0,plan);
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']})
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
 stage='mobile control settings';
 await page.goto(`${origin}/settings/agent-control`);
 await page.getByLabel('Identificador da sessão Happier',{exact:true}).fill(session.id);
 const linked=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/contexts')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Vincular conversa',exact:true}).click();assert.equal((await linked).status(),201);
 await page.getByRole('button',{name:/Pausar novas etapas|Retomar etapas/}).waitFor();
 const controlCommands=[];
 page.on('request',req=>{if(req.url().endsWith('/api/v1/ac/control')&&req.method()==='POST')controlCommands.push(req.postDataJSON())});
 const newProfiles=[];
 for(const width of [360,390]){
  stage=`account and profile ${width}`;await page.setViewportSize({width,height:844});
  const name=`Mobile synthetic ${width}`;
  await page.getByLabel('Nome da conta',{exact:true}).fill(name);
  await page.getByLabel('Elegibilidade da conta',{exact:true}).selectOption('documented_supported');
  const accountResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().postDataJSON()?.action==='account.add');
  await page.getByRole('button',{name:'Cadastrar conta',exact:true}).click();const created=await accountResponse;assert.equal(created.status(),200);
  const accountId=created.request().postDataJSON().payload.id;
  await page.getByLabel('Conta do perfil',{exact:true}).locator(`option[value="${accountId}"]`).waitFor({state:'attached'});
  await page.getByLabel('Conta do perfil',{exact:true}).selectOption(accountId);
  await page.getByLabel('Função do perfil',{exact:true}).selectOption('programmer');
  await page.getByLabel('Modelo validado',{exact:true}).selectOption('mobile-worker-v1');
  await page.getByLabel('Esforço do perfil',{exact:true}).selectOption(width===360?'medium':'high');
  const profileResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().postDataJSON()?.action==='profile.add');
  await page.getByRole('button',{name:'Cadastrar perfil',exact:true}).click();const made=await profileResponse;assert.equal(made.status(),200);
  const profileId=made.request().postDataJSON().payload.id;newProfiles.push(profileId);
  await page.getByLabel('Programação — adicionar reserva',{exact:true}).locator(`option[value="${profileId}"]`).waitFor({state:'attached'});
  const record=(await db.pool.query('SELECT account_id,model,effort,role FROM ac_profiles WHERE id=$1',[profileId])).rows[0];
  assert.equal(record.account_id,accountId);assert.equal(record.model,'mobile-worker-v1');assert.equal(record.effort,width===360?'medium':'high');assert.equal(record.role,'programmer');
  const accountRow=page.locator('li').filter({has:page.getByText(name,{exact:true})});
  await accountRow.getByLabel(`Novo nome ${name}`,{exact:true}).fill(`${name} renamed`);
  const renamed=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().postDataJSON()?.action==='account.rename');
  await accountRow.getByRole('button',{name:'Renomear conta',exact:true}).click();assert.equal((await renamed).status(),200);
  await page.locator('strong').filter({hasText:`${name} renamed`}).waitFor();
  const profileRow=page.locator('li').filter({hasText:`mobile-worker-v1 · ${width===360?'medium':'high'} · programmer`});
  await profileRow.getByRole('button',{name:'Criar nova versão do perfil',exact:true}).click();
  if(width===360){await profileRow.getByLabel('Função da nova versão',{exact:true}).selectOption('reviewer');await profileRow.getByLabel('Modelo da nova versão',{exact:true}).selectOption('mobile-review-v2');}
  else await profileRow.getByLabel('Esforço da nova versão',{exact:true}).selectOption('medium');
  const changed=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().postDataJSON()?.action==='profile.revise');
  await profileRow.getByRole('button',{name:'Salvar nova versão',exact:true}).click();const response=await changed;assert.equal(response.status(),200);
  const revised=response.request().postDataJSON().payload;const version=(await db.pool.query('SELECT model,effort,role FROM ac_profiles WHERE id=$1',[revised.newId])).rows[0];
  assert.equal(version.model,width===360?'mobile-review-v2':'mobile-worker-v1');assert.equal(version.role,width===360?'reviewer':'programmer');assert.equal(version.effort,width===360?'high':'medium');
  assert.equal((await db.pool.query('SELECT source_profile_id FROM ac_profile_lineage WHERE new_profile_id=$1',[revised.newId])).rows[0].source_profile_id,profileId);

 }
 console.log('PASS signed account rename and immutable profile revision after creation at 360 and 390');

 for(const width of [360,390]){
  await page.setViewportSize({width,height:844});
  for(const [label,after] of [['Pausar novas etapas','Retomar etapas'],['Retomar etapas','Pausar novas etapas']]){
   stage=`control lost ACK ${width} ${label}`;
   const button=page.getByRole('button',{name:label,exact:true});await button.waitFor();
   await page.waitForFunction(label=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===label);return !!b&&!b.disabled},label,{timeout:20000});
   let dropped=false;
   await page.route('**/api/v1/ac/control',async route=>{if(!dropped){dropped=true;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed')}else await route.continue()});
   const before=controlCommands.length;await button.click();
   await page.waitForFunction(()=>document.body.textContent.includes('Failed to fetch'),null,{timeout:5000}).catch(()=>{});
   await button.click({timeout:5000});
   await page.getByRole('button',{name:after,exact:true}).waitFor();
   await page.unroute('**/api/v1/ac/control');
   const attempts=controlCommands.slice(before);assert.equal(attempts.length,2);assert.equal(attempts[0].intentId,attempts[1].intentId);assert.notEqual(attempts[0].deliveryAttemptId,attempts[1].deliveryAttemptId);
  }
 }
 const pauseCommands=controlCommands.filter(c=>c.action==='context.pause');
 const ids=[...new Set(pauseCommands.map(c=>c.intentId))];assert.equal(ids.length,4);
 const rows=(await db.pool.query('SELECT intent_id,count(*)::int n FROM ac_control_deliveries WHERE intent_id=ANY($1::uuid[]) GROUP BY intent_id',[ids])).rows;
 assert.equal(rows.length,4);assert(rows.every(row=>row.n===2));
 const controls=(await db.pool.query("SELECT count(*)::int n FROM ac_control_intents WHERE id=ANY($1::uuid[]) AND action='context.pause'",[ids])).rows[0];assert.equal(controls.n,4);
 const context=(await db.pool.query('SELECT paused,pause_revision FROM ac_contexts WHERE id=$1',[pauseCommands[0].contextId])).rows[0];assert.equal(context.paused,false);assert.equal(context.pause_revision,4);
 console.log('PASS signed pause and resume retry same intent after dropped acknowledgment at 360 and 390, four effects and eight deliveries');
 for(const [width,revision,limit] of [[360,1,2],[390,2,3]]){
  stage=`policy lost ACK ${width}`;await page.setViewportSize({width,height:844});
  await page.getByLabel('Revisão para editar',{exact:true}).selectOption(String(revision));
  await page.getByRole('button',{name:'Carregar revisão',exact:true}).click();
  await page.getByLabel('Programadores por conversa',{exact:true}).fill(String(limit));
  if(width===360){
   await page.getByLabel('Programação — adicionar regular',{exact:true}).selectOption(newProfiles[0]);
   await page.getByLabel('Programação — adicionar reserva',{exact:true}).selectOption(newProfiles[1]);
  }
  await page.getByRole('button',{name:'Subir Programação regular 2',exact:true}).click();
  let dropped=false;await page.route('**/api/v1/ac/control',async route=>{if(!dropped){dropped=true;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed')}else await route.continue()});
  const publish=page.getByRole('button',{name:'Publicar nova revisão',exact:true}),before=controlCommands.length;
  await publish.click();await page.waitForFunction(()=>document.body.textContent.includes('Failed to fetch'),null,{timeout:5000}).catch(()=>{});
  await publish.click({timeout:5000});await page.unroute('**/api/v1/ac/control');
  await page.getByLabel('Revisão para editar',{exact:true}).locator(`option[value="${revision+1}"]`).waitFor({state:'attached'});
  const attempts=controlCommands.slice(before);assert.equal(attempts.length,2);assert.equal(attempts[0].intentId,attempts[1].intentId);assert.notEqual(attempts[0].deliveryAttemptId,attempts[1].deliveryAttemptId);
  const stored=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project.id,revision+1])).rows[0];assert.equal(stored.snapshot.maxProgrammersPerContext,limit);assert(stored.snapshot.roles.programmer.emergency.includes(newProfiles[1]));assert.equal(stored.snapshot.roles.programmer.regular.indexOf(newProfiles[0]),width===360?0:1);
  const deliveries=(await db.pool.query('SELECT count(*)::int n FROM ac_control_deliveries WHERE intent_id=$1',[attempts[0].intentId])).rows[0];assert.equal(deliveries.n,2);
 }
 console.log('PASS signed policy retry same intent after dropped acknowledgment at 360 and 390');

 for(const width of [360,390]){
  await page.setViewportSize({width,height:844});
  for(const [label,after] of [['Pausar novas etapas','Retomar etapas'],['Retomar etapas','Pausar novas etapas']]){
   stage=`control reconnect ${width} ${label}`;const button=page.getByRole('button',{name:label,exact:true});
   await page.waitForFunction(label=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===label);return !!b&&!b.disabled},label,{timeout:15000});
   let dropped=false;await page.route('**/api/v1/ac/control',async route=>{if(!dropped){dropped=true;await route.fetch();await route.abort('failed')}else await route.continue()});
   const before=controlCommands.length;await button.click();await page.waitForTimeout(500);await page.reload();await page.getByRole('button',{name:after,exact:true}).waitFor();await page.unroute('**/api/v1/ac/control');
   const sent=controlCommands.slice(before);assert.equal(sent.length,1);const found=(await db.pool.query('SELECT count(*)::int n FROM ac_control_intents WHERE id=$1',[sent[0].intentId])).rows[0];assert.equal(found.n,1);
  }
 }
 const stateAfterReconnect=(await db.pool.query('SELECT paused,pause_revision FROM ac_contexts WHERE id=$1',[contextId])).rows[0];assert.equal(stateAfterReconnect.paused,false);assert.equal(stateAfterReconnect.pause_revision,8);
 console.log('PASS signed pause/resume ACK loss followed by reload reconciles authoritative state at 360/390');
 for(const [width,revision,limit] of [[360,3,4],[390,4,5]]){
  stage=`policy reconnect ${width}`;await page.setViewportSize({width,height:844});
  await page.getByLabel('Revisão para editar',{exact:true}).selectOption(String(revision));await page.getByRole('button',{name:'Carregar revisão',exact:true}).click();
  await page.getByLabel('Programadores por conversa',{exact:true}).fill(String(limit));
  let dropped=false;await page.route('**/api/v1/ac/control',async route=>{if(!dropped){dropped=true;await route.fetch();await route.abort('failed')}else await route.continue()});
  const before=controlCommands.length;await page.getByRole('button',{name:'Publicar nova revisão',exact:true}).click();await page.waitForTimeout(500);await page.reload();
  await page.getByLabel('Revisão para editar',{exact:true}).locator(`option[value="${revision+1}"]`).waitFor({state:'attached'});await page.unroute('**/api/v1/ac/control');
  const sent=controlCommands.slice(before);assert.equal(sent.length,1);const row=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project.id,revision+1])).rows[0];assert.equal(row.snapshot.maxProgrammersPerContext,limit);
 }
 console.log('PASS signed policy ACK loss followed by reload reveals committed revision at 360/390');
 const startCommands=[];page.on('request',req=>{if(req.url().endsWith('/api/v1/ac/commands')&&req.method()==='POST')startCommands.push(req.postDataJSON())});
 for(const [width,revision] of [[360,1],[390,2]]){
  stage=`authenticated start ${width}`;await page.setViewportSize({width,height:844});
  if(revision===2){const manager=(await db.pool.query('SELECT instance_id,epoch FROM ac_managers WHERE context_id=$1',[contextId])).rows[0];
   await new ManagerPlans(db).publish(profile.id,{contextId,instanceId:manager.instance_id,epoch:Number(manager.epoch)},1,{...plan,objectiveRef:'message:second-objective',sourceMessageRef:'message:second-request'});
   await page.reload();}
  const proposal=page.getByRole('button',{name:new RegExp(`^Proposta ${revision},`)});await proposal.waitFor();await proposal.click();
  const launch=page.getByRole('button',{name:new RegExp(`^Solicitar execução da proposta ${revision},`)});await launch.waitFor();
  let dropped=false;await page.route('**/api/v1/ac/commands',async route=>{if(!dropped){dropped=true;const response=await route.fetch();if(response.status()!==202){console.error('START_REFUSAL',response.status(),await response.text());await route.fulfill({response});return}await route.abort('failed')}else await route.continue()});
  const before=startCommands.length;await launch.click();await page.waitForTimeout(500);await page.reload();await proposal.waitFor();await proposal.click();await launch.waitFor();await launch.click();
  await page.getByText(/Solicitação aceita/).waitFor();await page.unroute('**/api/v1/ac/commands');
  const attempts=startCommands.slice(before);assert.equal(attempts.length,2);assert.equal(attempts[0].intentId,attempts[1].intentId);assert.notEqual(attempts[0].deliveryAttemptId,attempts[1].deliveryAttemptId);
  const saved=(await db.pool.query('SELECT count(*)::int n FROM ac_intents WHERE id=$1 AND parent_intent_id IS NULL',[attempts[0].intentId])).rows[0];assert.equal(saved.n,1);
  const deliveries=(await db.pool.query('SELECT count(*)::int n FROM ac_deliveries WHERE intent_id=$1',[attempts[0].intentId])).rows[0];assert.equal(deliveries.n,2);
 }
 stage='policy refusals';
 const quotaBefore=(await db.pool.query('SELECT * FROM ac_quota_observations WHERE account_id=$1',[legacyAccount])).rows[0];
 const nativeBefore=(await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n;
 for(const width of [360,390]){
  await page.setViewportSize({width,height:844});
  for(const [index,code,message] of [[0,'ModelDisabledByPolicy','Este modelo está desabilitado pela política.'],[1,'MODEL_EFFORT_NOT_IN_CATALOG','Modelo ou esforço não homologado para esta função.'],[2,'POLICY_PROFILE_FORBIDDEN','Perfil indisponível ou conta removida deste projeto.']]){
  await page.reload();await page.getByLabel('Programação — adicionar regular',{exact:true}).locator(`option[value="${legacyProfiles[index]}"]`).waitFor({state:'attached'});
  await page.getByLabel('Programação — adicionar regular',{exact:true}).selectOption(legacyProfiles[index]);
  if(index===2)await db.pool.query('DELETE FROM ac_account_access WHERE account_id=$1 AND project_id=$2',[legacyAccount,project.id]);
  const rejected=page.waitForResponse(r=>r.url().endsWith('/api/v1/ac/control')&&r.request().postDataJSON()?.action==='policy.publish');
  await page.getByRole('button',{name:'Publicar nova revisão',exact:true}).click();const response=await rejected;assert.equal(response.status(),index===2?403:code==='ModelDisabledByPolicy'?403:409);
  assert.equal((await response.json()).error,code);await page.getByRole('alert').filter({hasText:message}).waitFor();
  }
  if(width===360)await db.pool.query('INSERT INTO ac_account_access VALUES($1,$2)',[legacyAccount,project.id]);
 }
 assert.deepEqual((await db.pool.query('SELECT * FROM ac_quota_observations WHERE account_id=$1',[legacyAccount])).rows[0],quotaBefore);
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n,nativeBefore);
 console.log('PASS signed policy refusals Astra, forbidden effort, removed account at 360/390; readable reason, no launch or quota change');
 assert.notEqual(startCommands[0].intentId,startCommands[2].intentId);
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n,0);
 console.log('PASS authenticated start reconnect/reload and retry at 360/390, distinct proposals/intents, no native worker started');

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
