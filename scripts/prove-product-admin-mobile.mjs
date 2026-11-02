// Composite lab proof: real server-main and browser, synthetic identity and repos only.
// Run after the managed UI build; never run against an operational database or service.
import {chromium} from '../upstream/cezar/node_modules/playwright-core/index.mjs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import nacl from 'tweetnacl';
import assert from 'node:assert/strict';
import {Ledger} from '../src/ledger.ts';
import {Operators} from '../src/operator.ts';
import {initializeInstallation} from '../src/installation.ts';
import {isolatedDatabase} from '../tests/fixtures/isolated-database.ts';

const database=process.env.AC_TEST_DATABASE_URL;
if(!database?.endsWith('/ac_implementation_test')||!['db','127.0.0.1','localhost'].includes(new URL(database).hostname))throw Error('ISOLATED_DATABASE_REQUIRED');
const isolated=await isolatedDatabase(database,'mobileadmin'),db=new Ledger(isolated.url);
const b64=bytes=>Buffer.from(bytes).toString('base64');
const evidenceId=randomUUID(),evidencePrefix=`docs/validation/evidence/product-admin-mobile-${evidenceId}`;
let browser,gateway,temporary,reportForEvidence,stage='synthetic setup',page;
try{
 const native=await import('../upstream/happier/node_modules/.agent-control-boundary.mjs');
 const seed=randomBytes(32),pair=nacl.sign.keyPair.fromSeed(seed),challenge=randomBytes(32),contentKey=randomBytes(32);
 const auth=await fetch('http://127.0.0.1:18401/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))})});
 assert.equal(auth.status,200);const {token}=await auth.json();
 const profile=await (await fetch('http://127.0.0.1:18401/v1/account/profile',{headers:{authorization:'Bearer '+token}})).json();assert.equal(typeof profile.id,'string');
 await mkdir('.state/projects',{recursive:true});temporary=await mkdtemp(resolve('.state/projects/ac-mobile-admin-'));
 const projectRoots=[{id:'synthetic-root',label:'Raiz sintética de teste',path:temporary}],projects=[];
 for(const [index,name] of ['Admin Alpha','Admin Beta','Admin Gamma'].entries()){
  const repo=join(temporary,['alpha','beta','gamma'][index]);await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe'});
  git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
  await writeFile(join(repo,'README.md'),`${name} synthetic fixture\n`);git('add','.');git('commit','-qm','fixture');
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[]}));
  projects.push({id:randomUUID(),label:name,repo,owner:profile.id});
 }
 const origin='http://127.0.0.1:18405',config={schemaVersion:1,mode:'administration-only',databaseUrl:isolated.url,dataDirectory:join(temporary,'private'),project:projects[0],projects:[projects[1]],projectRoots,
  http:{listen:'127.0.0.1',port:18405,publicOrigin:origin},happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'},sessionMaxAgeSeconds:3600};
 await initializeInstallation(config,db);
 await db.createContext(profile.id,projects[0].id,`synthetic-${randomUUID()}`);
 const configPath=join(temporary,'installation.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 stage='gateway startup';gateway=spawn(process.execPath,['--import','tsx','src/server-main.ts','serve',configPath],{env:process.env,stdio:['ignore','pipe','pipe']});
 let output='';gateway.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-4000)});gateway.stderr.on('data',()=>{});
 for(let i=0;i<200&&!output.includes('administration_ready');i++){if(gateway.exitCode!==null)throw Error('GATEWAY_EXITED');await new Promise(r=>setTimeout(r,100));}
 assert(output.includes('administration_ready'),'gateway startup timed out');
 stage='synthetic browser login';browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const client=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page=await client.newPage();
 const forbidden=[];page.on('request',request=>{const url=new URL(request.url());if(request.method()!=='GET'&&(url.pathname==='/api/v1/ac/commands'||/\/runs(?:\/|$)/.test(url.pathname)||url.pathname.startsWith('/api/v1/telemetry/')||url.pathname==='/api/v1/workspace/ui-state'))forbidden.push(url.pathname)});
 const auditResponses=[];
 if(process.env.AC_UI_REQUEST_AUDIT==='1')page.on('response',response=>{if(response.status()===403){const request=response.request(),url=new URL(response.url());if(url.origin===origin)auditResponses.push({method:request.method(),path:url.pathname,status:response.status()});}});
 await page.goto(`${origin}/p/${projects[0].id}/settings/agent-control`);
 await page.getByText('Entrar pelo Happier',{exact:true}).click();const link=page.getByText('Autorizar no Happier',{exact:true});await link.waitFor();
 const linkUrl=new URL(await link.getAttribute('href')),params=new URLSearchParams(linkUrl.hash.slice(1));
 assert.equal(linkUrl.origin,'http://127.0.0.1:18400');
 const publicKey=Buffer.from(params.get('key'),'base64url'),pairingSecret=Buffer.from(params.get('pairingSecret'),'base64url');
 const sealed=native.sealTerminalProvisioningV3Payload({contentPrivateKey:contentKey,terminalEphemeralPublicKey:publicKey,pairingSecret,createdAtMs:Number(params.get('createdAt')),expiresAtMs:Number(params.get('expiresAt')),randomBytes:length=>new Uint8Array(randomBytes(length))});
 const answer=await fetch('http://127.0.0.1:18401/v1/auth/response',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({publicKey:b64(publicKey),response:b64(sealed)})});assert.equal(answer.status,200);
 await page.getByText('Dispositivo de administração',{exact:true}).waitFor({timeout:30000});
 await page.getByRole('heading',{name:'Diagnóstico da conversa',exact:true}).first().waitFor();
 try{await page.waitForFunction(()=>[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(element=>element.textContent==='Diagnóstico da conversa').length===1,null,{timeout:2000});}catch{}
 const diagnosticHeadings=await page.getByRole('heading',{name:'Diagnóstico da conversa',exact:true}).count();
 console.log(`PRODUCT_ADMIN_MOBILE_DIAGNOSTIC_HEADINGS: ${diagnosticHeadings}`);
 if(diagnosticHeadings!==1){
  const structure=await page.evaluate(()=>{
   const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(element=>element.textContent==='Diagnóstico da conversa');
   const containers=headings.map(element=>element.closest('div.flex.min-w-0.flex-col.gap-6'));
   return {routes:document.querySelectorAll('[data-route="settings-agent-control"]').length,roots:document.querySelectorAll('#root').length,
    sameContainer:containers.length===2&&containers[0]===containers[1],containerCount:new Set(containers).size,
    headings:headings.map(element=>{const chain=[];let node=element;for(let i=0;node&&i<8;i++,node=node.parentElement){
     const style=getComputedStyle(node),rect=node.getBoundingClientRect(),route=node.getAttribute('data-route');
     chain.push({tag:node.tagName.toLowerCase(),siblingIndex:node.parentElement?[...node.parentElement.children].indexOf(node):null,route:route==='settings-agent-control'?route:null,classes:node.className&&typeof node.className==='string'?node.className:null,
      display:style.display,visibility:style.visibility,hasBox:rect.width>0&&rect.height>0});
    }const fiberKey=Object.keys(element).find(key=>key.startsWith('__reactFiber$'));let fiber=fiberKey?element[fiberKey]:null;const owners=[];
    for(let i=0;fiber&&i<25;i++,fiber=fiber.return){const type=fiber.type,name=typeof type==='string'?type:typeof type==='function'?(type.displayName||type.name):null;
     if(typeof name==='string'&&/^[A-Za-z0-9_$-]{1,50}$/.test(name))owners.push(name);
    }return {chain,owners}})};
  });
  console.error(`PRODUCT_ADMIN_MOBILE_DIAGNOSTIC_STRUCTURE: ${JSON.stringify(structure)}`);
 }
 assert.equal(diagnosticHeadings,1,'expected one diagnostic panel');
 stage='operator device bootstrap';const bootstrap=randomBytes(32).toString('hex');await new Operators(db).prepareBootstrap(profile.id,profile.id,bootstrap);
 await page.getByLabel('Código de ativação',{exact:true}).fill(bootstrap);await page.getByText('Ativar este dispositivo',{exact:true}).click();
 await page.getByText('Dispositivo autorizado.',{exact:true}).waitFor();
 if(process.env.AC_UI_REQUEST_AUDIT==='1'){
  await new Promise(resolve=>setTimeout(resolve,2000));
  console.log(`PRODUCT_ADMIN_MOBILE_DENIED_REQUESTS: ${JSON.stringify(auditResponses)}`);
  throw Error('AUDIT_COMPLETE');
 }
 stage='registration: panel';await page.getByText('Projetos e servidor',{exact:true}).waitFor();
 stage='registration: root capabilities';
 const rootsResponse=await page.request.get(origin+'/api/v1/ac/project-admin',{headers:{'X-Agent-Control-Project':projects[0].id}});
 assert.equal(rootsResponse.status(),200);const roots=await rootsResponse.json();
 assert.deepEqual(roots.roots,[{id:'synthetic-root',label:'Raiz sintética de teste'}]);assert(!JSON.stringify(roots).includes(temporary));
 stage='registration: project name';await page.getByLabel('Nome do projeto',{exact:true}).fill(projects[2].label);
 stage='registration: root selection';
 await page.getByLabel('Raiz autorizada',{exact:true}).selectOption('synthetic-root');
 stage='registration: relative path';await page.getByLabel('Caminho relativo do repositório',{exact:true}).fill('gamma');
 const sent=page.waitForRequest(request=>request.url()===origin+'/api/v1/ac/project-admin'&&request.method()==='POST');
 const received=page.waitForResponse(response=>response.url()===origin+'/api/v1/ac/project-admin'&&response.request().method()==='POST');
 stage='registration: submit and response';await page.getByText('Cadastrar projeto',{exact:true}).click();const [request,response]=await Promise.all([sent,received]);
 assert.equal(response.status(),200);const headers=await request.allHeaders(),command=request.postDataJSON();
 assert(headers['x-ac-operator-proof']);assert.equal(headers['x-agent-control-project'],projects[0].id);
 assert.equal(command.action,'project.register');assert.equal(command.payload.label,projects[2].label);assert.equal(command.payload.rootId,'synthetic-root');assert.equal(command.payload.relativePath,'gamma');
 const registered=(await response.json()).projectId;assert.equal(registered,command.payload.projectId);
 stage='registration: success status';await page.getByText('Projeto cadastrado.',{exact:true}).waitFor();
 await page.getByText('Projeto cadastrado.',{exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:`${evidencePrefix}-registration-390.png`});
 const row=(await db.pool.query('SELECT p.label,r.repo,m.role FROM ac_projects p JOIN ac_project_repositories r ON r.project_id=p.id JOIN ac_memberships m ON m.project_id=p.id WHERE p.id=$1 AND m.principal_id=$2',[registered,profile.id])).rows[0];
 assert.deepEqual(row,{label:projects[2].label,repo:projects[2].repo,role:'owner'});
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_admin_intents WHERE id=$1',[command.intentId])).rows[0].n,1);
 const listed=await page.request.get(origin+'/api/v1/projects');assert.equal(listed.status(),200);
 assert((await listed.json()).projects.some(project=>project.id===registered&&project.name===projects[2].label));
 stage='sanitized import preview';
 const marker='SYNTHETIC_PRIVATE_CIPHERTEXT_ONLY',bundle={schemaVersion:1,importId:randomUUID(),projectId:projects[0].id,sourceNamespace:'synthetic-namespace',contexts:[{id:'synthetic-external-context',sessionId:'synthetic-private-session',sourcePaused:true,keyVariant:'legacy',keyFingerprint:'a'.repeat(64),messages:[{id:'synthetic-private-message',ciphertext:marker}],runs:[]}]};
 const content=Buffer.from(JSON.stringify(bundle));const before=(await db.pool.query('SELECT count(*)::int n FROM ac_import_batches')).rows[0].n;
 await page.getByLabel('Pacote JSON',{exact:true}).setInputFiles({name:'synthetic-import.json',mimeType:'application/json',buffer:content});
 const previewResponse=page.waitForResponse(response=>response.url()===origin+'/api/v1/ac/import/preview'&&response.request().method()==='POST');
 await page.getByText('Ver prévia',{exact:true}).click();const preview=await previewResponse;assert.equal(preview.status(),200);
 const previewHeaders=await preview.request().allHeaders(),report=await preview.json();assert.equal(previewHeaders['x-agent-control-project'],projects[0].id);
 assert.equal(report.projectId,projects[0].id);assert.equal(report.inputSha256,createHash('sha256').update(content).digest('hex'));
 assert.equal(report.counts.contexts,1);assert.equal(report.counts.messages,1);assert.equal(report.executionEnabled,false);
 assert.deepEqual(report.checks,{schemaValid:true,projectOwner:true,sessionOwnershipVerified:false,keysVerified:false,ciphertextVerified:false});
 for(const secret of [marker,bundle.sourceNamespace,bundle.contexts[0].sessionId,bundle.contexts[0].id,bundle.contexts[0].messages[0].id,bundle.contexts[0].keyFingerprint])assert(!JSON.stringify(report).includes(secret));
 await page.getByText('Prévia válida para este projeto. Nenhum dado foi importado.',{exact:true}).waitFor();
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_import_batches')).rows[0].n,before);
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_import_batches')).rows[0].n,0);
 for(const table of ['ac_intents','ac_operations','ac_outbox','ac_capacity_grants'])assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
 assert.equal(forbidden.length,0);
 assert.equal(await page.getByText('CANONICAL_HAPPIER_REQUIRED',{exact:true}).count(),0);
 stage='mobile viewport';for(const width of [360,390]){
  await page.setViewportSize({width,height:844});const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  assert(geometry.scroll<=geometry.width+1,`horizontal overflow at ${width}`);
  await page.getByText('Prévia válida para este projeto. Nenhum dado foi importado.',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:`${evidencePrefix}-${width}.png`});
 }
 reportForEvidence={result:'passed',registeredProjects:3,signedRegistration:true,operatorBootstrap:true,projectHeaders:true,sanitizedImportPreview:true,importedBatches:0,executionIntents:0,operations:0,outbox:0,grants:0,viewports:[360,390],
  limits:['Synthetic identities, sessions and repositories; no model inference or real accounts.','Happier pairing approved by synthetic client, not native approval UI.','The synthetic account remains in the disposable Happier lab service.','No physical phone, import execution, backup restoration or production deploy.']};
}catch(error){
 // Browser failures can contain pairing links and other session material; do not print them.
 if(error instanceof Error&&error.message==='AUDIT_COMPLETE')console.log('PRODUCT_ADMIN_MOBILE_AUDIT_COMPLETE');
 else{console.error(`PRODUCT_ADMIN_MOBILE_FAILED: ${stage} (${error instanceof Error?error.name:'unknown error'})`);process.exitCode=1;}
 if(page&&stage.startsWith('registration:')){
  try{
   const indicators=await page.evaluate(()=>({
    panel:[...document.querySelectorAll('h2')].some(element=>element.textContent==='Projetos e servidor'),
    inputs:document.querySelectorAll('input').length,
    registrationButton:[...document.querySelectorAll('button')].filter(element=>element.textContent==='Cadastrar projeto').map(element=>({disabled:element.disabled})),
    alerts:[...document.querySelectorAll('[role="alert"]')].map(element=>element.textContent).filter(text=>/^[A-Z][A-Z_0-9]{1,80}$/.test(text??'')),
   }));
   console.error(`PRODUCT_ADMIN_MOBILE_INDICATORS: ${JSON.stringify(indicators)}`);
   await page.screenshot({path:`${evidencePrefix}-registration-failure.png`});
  }catch{console.error('PRODUCT_ADMIN_MOBILE_INDICATORS_UNAVAILABLE');}
 }
}finally{
 let cleanupFailed=false;
 try{await browser?.close();}catch{cleanupFailed=true;}
 if(gateway&&gateway.exitCode===null){
  const exited=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill('SIGTERM');
  let timer;const grace=await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000)})]);clearTimeout(timer);
  if(!grace){gateway.kill('SIGKILL');await exited;}
 }
 try{await db.close();}catch{cleanupFailed=true;}
 try{await isolated.close();}catch{cleanupFailed=true;}
 if(temporary)try{await rm(temporary,{recursive:true,force:true});}catch{cleanupFailed=true;}
 if(cleanupFailed){console.error('PRODUCT_ADMIN_MOBILE_CLEANUP_FAILED');process.exitCode=1;}
}
if(reportForEvidence&&process.exitCode!==1){
 await writeFile(`${evidencePrefix}.json`,JSON.stringify(reportForEvidence,null,2)+'\n',{flag:'wx'});
 console.log(`PRODUCT_ADMIN_MOBILE_PASSED: synthetic proof ${evidenceId}`);
}
