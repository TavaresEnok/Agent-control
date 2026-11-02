// Mobile integration proof: isolated database/repositories and synthetic Happier identity only.
// Run only after the managed web build completes; no model, worker, or external account is used.
import {chromium} from '../upstream/cezar/node_modules/playwright-core/index.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import nacl from 'tweetnacl';
import assert from 'node:assert/strict';
import {Ledger} from '../src/ledger.ts';
import {initializeInstallation} from '../src/installation.ts';
import {ManagerPlans} from '../src/planning.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from '../tests/fixtures/isolated-database.ts';

const database=process.env.AC_TEST_DATABASE_URL;
if(!database?.endsWith('/ac_implementation_test')||!['db','127.0.0.1','localhost'].includes(new URL(database).hostname))throw Error('ISOLATED_DATABASE_REQUIRED');
const isolated=await isolatedDatabase(database,'mobileproduct'),db=new Ledger(isolated.url);
const native=await import('../upstream/happier/node_modules/.agent-control-boundary.mjs');
const b64=bytes=>Buffer.from(bytes).toString('base64');
let browser,gateway,temporary,stage='synthetic setup';
try{
 const seed=randomBytes(32),pair=nacl.sign.keyPair.fromSeed(seed),challenge=randomBytes(32),contentKey=randomBytes(32);
 const auth=await fetch('http://127.0.0.1:18401/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))})});
 assert.equal(auth.status,200);const {token}=await auth.json();
 const profile=await (await fetch('http://127.0.0.1:18401/v1/account/profile',{headers:{authorization:'Bearer '+token}})).json();
 assert.equal(typeof profile.id,'string');
 await mkdir('.state/projects',{recursive:true});temporary=await mkdtemp(resolve('.state/projects/ac-mobile-product-'));
 const projects=[];
 for(const name of ['Mobile Alpha','Mobile Beta']){
  const repo=join(temporary,name.endsWith('Alpha')?'alpha':'beta');await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe'});
  git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
  await writeFile(join(repo,'README.md'),`${name} synthetic fixture\n`);git('add','.');git('commit','-qm','fixture');
  await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[]}));
  projects.push({id:randomUUID(),label:name,repo,owner:profile.id});
 }
 const origin='http://127.0.0.1:18404',config={schemaVersion:1,mode:'administration-only',databaseUrl:isolated.url,dataDirectory:join(temporary,'private'),project:projects[0],projects:[projects[1]],
  http:{listen:'127.0.0.1',port:18404,publicOrigin:origin},happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'},sessionMaxAgeSeconds:3600};
 await initializeInstallation(config,db);
 const contextIds=[],proposalDigests=[];
 for(const project of projects){
  const context=await db.createContext(profile.id,project.id,`mobile-${randomUUID()}`);contextIds.push(context);
  const quality={schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:false,requireHumanIntegration:false,verifierDigest:'a'.repeat(64)};
  await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[project.id,quality,digest(quality)]);
  const authority=await db.acquire(profile.id,context,randomUUID(),'synthetic-mobile-manager',60);
  const plan={schemaVersion:1,contextId:context,objectiveRef:`message:${project.label.endsWith('Alpha')?'alpha':'beta'}`,sourceMessageRef:'message:request',constraintRefs:[],tasks:[{id:'one',objectiveRef:'message:task',acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one'],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0}]};
  const saved=await new ManagerPlans(db).publish(profile.id,authority,0,plan);proposalDigests.push(saved.digest);
 }
 const configPath=join(temporary,'installation.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 stage='gateway startup';gateway=spawn(process.execPath,['--import','tsx','src/server-main.ts','serve',configPath],{env:process.env,stdio:['ignore','pipe','pipe']});
 let output='',errors='';gateway.stdout.on('data',chunk=>{output=(output+chunk).slice(-4000)});gateway.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000)});
 for(let i=0;i<200&&!output.includes('administration_ready');i++){if(gateway.exitCode!==null)throw Error('GATEWAY_EXITED '+errors);await new Promise(r=>setTimeout(r,100));}
 assert(output.includes('administration_ready'),'gateway startup timed out');
 stage='browser login';browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const client=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await client.addInitScript(()=>{
  const Native=window.EventSource;window.__acStreams=[];
  window.EventSource=class extends Native{constructor(url,init){super(url,init);this.__record={url:String(url),closed:false,opened:false};this.addEventListener('open',()=>{this.__record.opened=true});window.__acStreams.push(this.__record)}close(){this.__record.closed=true;super.close()}};
 });
 const page=await client.newPage(),commands=[];
 page.on('request',request=>{if(request.url()===origin+'/api/v1/ac/commands')commands.push(request.postDataJSON())});
 await page.goto(`${origin}/p/${projects[0].id}/settings/agent-control`);
 await page.getByText('Entrar pelo Happier',{exact:true}).click();
 const link=page.getByText('Autorizar no Happier',{exact:true});await link.waitFor();
 const url=new URL(await link.getAttribute('href')),params=new URLSearchParams(url.hash.slice(1));
 const publicKey=Buffer.from(params.get('key'),'base64url'),pairingSecret=Buffer.from(params.get('pairingSecret'),'base64url');
 const sealed=native.sealTerminalProvisioningV3Payload({contentPrivateKey:contentKey,terminalEphemeralPublicKey:publicKey,pairingSecret,createdAtMs:Number(params.get('createdAt')),expiresAtMs:Number(params.get('expiresAt')),randomBytes:length=>new Uint8Array(randomBytes(length))});
 const answer=await fetch('http://127.0.0.1:18401/v1/auth/response',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({publicKey:b64(publicKey),response:b64(sealed)})});assert.equal(answer.status,200);
 await page.getByText('Planejamento do gerente',{exact:true}).waitFor({timeout:30000});
 const list=await page.request.get(origin+'/api/v1/projects');assert.equal(list.status(),200);
 const registered=await list.json();assert.deepEqual(new Set(registered.projects.map(p=>p.id)),new Set(projects.map(p=>p.id)));
 async function checkCurrent(index){
  const scoped=await page.request.get(origin+'/api/v1/ac/contexts',{headers:{'X-Agent-Control-Project':projects[index].id}});
  assert.equal(scoped.status(),200);assert.deepEqual((await scoped.json()).contexts.map(c=>c.id),[contextIds[index]]);
  await page.getByText('Proposta 1 · 1 tarefas',{exact:true}).click();
  await page.getByText(`message:${index===0?'alpha':'beta'}`,{exact:false}).first().waitFor();
  await page.getByText(proposalDigests[index],{exact:false}).waitFor();
  assert.equal(await page.getByText(`message:${index===0?'beta':'alpha'}`,{exact:false}).count(),0,'cross-project proposal shown');
  await page.waitForFunction(id=>window.__acStreams.some(s=>s.url.includes(`/p/${id}/workspace/events`)&&!s.closed&&s.opened),projects[index].id);
  await page.getByText('Solicitar execução desta proposta',{exact:true}).click();
  await page.getByText('MANAGER_UNAVAILABLE',{exact:true}).waitFor();
  const command=commands.at(-1);assert.equal(command.contextId,contextIds[index]);assert.equal(command.payload.proposalDigest,proposalDigests[index]);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_intents WHERE context_id=$1',[contextIds[index]])).rows[0].n,0);
 }
 stage='project alpha and proposal';await checkCurrent(0);
 // Settings uses the native project tree; the mobile drawer retains the current section on selection.
 stage='native project switch';await page.getByRole('button',{name:'Open settings menu'}).click();
 const drawer=page.locator('[data-slot="settings-mobile-drawer"]');await drawer.waitFor();
 const row=drawer.locator(`[data-slot="settings-project"][data-project="${projects[1].id}"]`);
 await row.locator('[data-slot="settings-project-link"]').click();
 await page.waitForURL(`**/p/${projects[1].id}/settings/agent-control`);
 await page.waitForFunction(id=>window.__acStreams.some(s=>s.url.includes(`/p/${id}/workspace/events`)&&s.closed),projects[0].id);
 stage='project beta and proposal';await checkCurrent(1);
 stage='mobile viewport geometry';
 for(const width of [360,390]){
  await page.setViewportSize({width,height:844});
  const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  assert(geometry.scroll<=geometry.width+1,`horizontal overflow at ${width}: ${JSON.stringify(geometry)}`);
  const button=page.getByText('Solicitar execução desta proposta',{exact:true});await button.scrollIntoViewIfNeeded();
  const box=await button.boundingBox();assert(box&&box.width>0&&box.x>=0&&box.x+box.width<=width+1,`action outside viewport ${width}`);
  await page.screenshot({path:`docs/validation/evidence/product-mobile-${width}.png`});
 }
 await writeFile('docs/validation/evidence/product-mobile-integrated-proof.json',JSON.stringify({result:'passed',projects:2,viewports:[360,390],nativeProjectSwitch:true,projectScopedProposalAndCache:true,managerUnavailableHonest:true,scopedStreamCloseOnSwitch:true,nativeEventSourceOpenConfirmed:true,
  limits:['Synthetic identities and repositories only; no workers or model inference.','Native Happier approval UI and physical phone not exercised.','Browser proof does not replace independent review or production deployment validation.']},null,2)+'\n');
 console.log('PRODUCT_MOBILE_PASSED: 2 synthetic projects; viewports 360/390; stream switch and unavailable manager checked');
}catch(error){
 // Do not print browser/network errors: they may contain pairing links or session material.
 console.error(`PRODUCT_MOBILE_FAILED: ${stage} (${error instanceof Error?error.name:'unknown error'})`);process.exitCode=1;
}finally{
 await browser?.close();if(gateway&&gateway.exitCode===null){gateway.kill('SIGTERM');await new Promise(resolve=>gateway.once('exit',resolve));}
 await db.close();await isolated.close();if(temporary)await rm(temporary,{recursive:true,force:true});
}
