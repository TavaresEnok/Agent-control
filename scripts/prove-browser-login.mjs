// Real Chromium + native Happier server/crypto, synthetic approval client.
// Does not start managers/workers, read operational accounts or publish ports.
import {chromium} from '../upstream/cezar/node_modules/playwright-core/index.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import nacl from 'tweetnacl';
import {Ledger} from '../src/ledger.ts';
import {Operators} from '../src/operator.ts';
import {isolatedDatabase} from '../tests/fixtures/isolated-database.ts';
import assert from 'node:assert/strict';
const database=process.env.AC_TEST_DATABASE_URL;
if(!database?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
const isolated=await isolatedDatabase(database,'browserlogin'),db=new Ledger(isolated.url);await db.migrate();
const native=await import('../upstream/happier/node_modules/.agent-control-boundary.mjs');
const b64=bytes=>Buffer.from(bytes).toString('base64');
let gateway,browser,configPath;
try{
 const users=[];
 for(let i=0;i<2;i++){
  const seed=randomBytes(32),pair=nacl.sign.keyPair.fromSeed(seed),challenge=randomBytes(32);
  const auth=await fetch('http://127.0.0.1:18401/v1/auth',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))})});
  assert.equal(auth.status,200);const {token}=await auth.json();
  const profile=await(await fetch('http://127.0.0.1:18401/v1/account/profile',{headers:{authorization:'Bearer '+token}})).json();
  users.push({token,id:profile.id,contentKey:randomBytes(32)});
 }
 const project=randomUUID(),admin='browser-login-admin-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Browser login acceptance']);
 for(const user of users)await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,user.id]);
 await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[admin]);
 let contextId,sessionId;
 await mkdir('.state/projects',{recursive:true});const repo=await mkdtemp(resolve('.state/projects/ac-browser-login-'));
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Synthetic fixture');
 await writeFile(join(repo,'README.md'),'Browser authentication fixture only\n');git('add','.');git('commit','-qm','base');
 await mkdir(join(repo,'.ai/cezar'),{recursive:true});await writeFile(join(repo,'.ai/cezar/config.json'),JSON.stringify({baseBranch:'main',skillsRepos:[]}));
 configPath=join(repo,'gateway-fixture.json');await writeFile(configPath,JSON.stringify({scope:'isolated-browser-login',repo,project}),{mode:0o600});
 gateway=spawn(process.execPath,['--import','tsx','tests/fixtures/browser-login-gateway.ts',configPath],{env:{...process.env,AC_TEST_DATABASE_URL:isolated.url},stdio:['ignore','pipe','pipe']});
 let output='';gateway.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-2000)});gateway.stderr.on('data',()=>{});
 for(let i=0;i<100&&!output.includes('BROWSER_LOGIN_FIXTURE_READY');i++){
  if(gateway.exitCode!==null)throw Error('GATEWAY_FIXTURE_EXITED');await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert(output.includes('BROWSER_LOGIN_FIXTURE_READY'),'fixture did not start');
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const client=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await client.newPage(),origin='http://127.0.0.1:18403';
 const observedBodies=[];
 page.on('request',request=>{if(request.url().startsWith(origin+'/api/v1/ac/auth/pair'))observedBodies.push(request.postData()??'')});
 const deviceIds=[];
 for(let index=0;index<users.length;index++){
  const user=users[index];await page.goto(origin+`/p/${project}/settings/agent-control`);
  await page.getByText('Entrar pelo Happier',{exact:true}).waitFor();await page.getByText('Entrar pelo Happier',{exact:true}).click();
  const link=page.getByText('Autorizar no Happier',{exact:true});await link.waitFor();
  const url=new URL(await link.getAttribute('href')),params=new URLSearchParams(url.hash.slice(1));
  const publicKey=Buffer.from(params.get('key'),'base64url'),pairingSecret=Buffer.from(params.get('pairingSecret'),'base64url');
  assert.equal(url.origin,'http://127.0.0.1:18400');
  const sealed=native.sealTerminalProvisioningV3Payload({contentPrivateKey:user.contentKey,terminalEphemeralPublicKey:publicKey,pairingSecret,
   createdAtMs:Number(params.get('createdAt')),expiresAtMs:Number(params.get('expiresAt')),randomBytes:length=>new Uint8Array(randomBytes(length))});
  const answer=await fetch('http://127.0.0.1:18401/v1/auth/response',{method:'POST',headers:{authorization:'Bearer '+user.token,'content-type':'application/json'},
   body:JSON.stringify({publicKey:b64(publicKey),response:b64(sealed)})});assert.equal(answer.status,200);
  await page.getByText('Dispositivo de administração',{exact:true}).waitFor({timeout:30000});
  const status=await(await page.request.get(origin+'/api/v1/ac/auth/status')).json();assert.equal(status.principalId,user.id);
  const cookie=(await client.cookies(origin+'/api/')).find(cookie=>cookie.name==='ac_session');assert(cookie?.httpOnly);assert.equal(cookie.sameSite,'Strict');
  if(index===0){
   const seal=value=>native.encodeBase64(native.encrypt(user.contentKey,'legacy',value));
   const created=await fetch('http://127.0.0.1:18401/v1/sessions',{method:'POST',headers:{authorization:'Bearer '+user.token,'content-type':'application/json'},
    body:JSON.stringify({tag:'browser-login-'+randomUUID(),encryptionMode:'e2ee',metadata:seal({path:repo,name:'Synthetic browser conversation'}),agentState:seal({requests:{}})})});
   assert.equal(created.status,200);sessionId=(await created.json()).session.id;
   await page.getByLabel('Identificador da sessão Happier',{exact:true}).fill(sessionId);
   await page.getByText('Vincular conversa',{exact:true}).click();
   for(let i=0;i<80;i++){
    const linked=(await db.pool.query('SELECT context_id FROM ac_session_links WHERE session_id=$1',[sessionId])).rows[0];
    if(linked){contextId=linked.context_id;break;}await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert(contextId,'first conversation was not linked');
   const repeat=await page.request.post(origin+'/api/v1/ac/contexts',{headers:{origin},data:{projectId:project,happierSessionId:sessionId}});
   assert.equal(repeat.status(),201);assert.equal((await repeat.json()).contextId,contextId);
   await page.getByText('Concluir planos aceitos e aguardar',{exact:true}).waitFor();
  }else{
   const foreign=await page.request.post(origin+'/api/v1/ac/contexts',{headers:{origin},data:{projectId:project,happierSessionId:sessionId}});
   assert.equal(foreign.status(),403);assert.equal((await foreign.json()).error,'SESSION_OWNERSHIP_UNVERIFIED');
  }
  const missingProof=await page.request.post(origin+'/api/v1/ac/control',{headers:{origin},data:{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,
   action:'context.drain',payload:{draining:true,expectedRevision:index}}});assert.equal(missingProof.status(),403);assert.equal((await missingProof.json()).error,'HUMAN_CONTROL_AUTH_REQUIRED');
  const bootstrap=randomBytes(32).toString('hex');await new Operators(db).prepareBootstrap(admin,user.id,bootstrap);
  await page.getByLabel('Código de ativação',{exact:true}).fill(bootstrap);await page.getByText('Ativar este dispositivo',{exact:true}).click();
  await page.getByText('Dispositivo autorizado.',{exact:true}).waitFor();
  await page.getByText(index===0?'Concluir planos aceitos e aguardar':'Permitir novos planos',{exact:true}).click();
  let changed=false;
  for(let i=0;i<80;i++){
   const row=(await db.pool.query('SELECT draining,drain_revision FROM ac_contexts WHERE id=$1',[contextId])).rows[0];
   if(row.draining===(index===0)&&row.drain_revision===index+1){changed=true;break;}await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(changed,'signed browser control did not persist');
  const device=(await db.pool.query("SELECT id FROM ac_operator_keys WHERE principal_id=$1 AND state='active'",[user.id])).rows[0];deviceIds.push(device.id);
  const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
  assert(!storage.includes(b64(user.contentKey)));assert(!storage.includes(user.token));
  assert(observedBodies.every(body=>!body.includes(b64(user.contentKey))&&!body.includes(params.get('pairingSecret'))));
  if(index===0){await page.screenshot({path:'docs/validation/evidence/browser-login-bootstrap-mobile-390.png'});await page.getByText('Sair deste navegador',{exact:true}).click();}
 }
 assert.notEqual(deviceIds[0],deviceIds[1],'accounts must not share the browser operator signing identity');
 const cross=await page.request.post(origin+'/api/v1/ac/auth/pair',{headers:{origin:'https://untrusted.example'},data:{publicKey:b64(randomBytes(32)),claimSecretHash:randomBytes(32).toString('base64url')}});
 assert.equal(cross.status(),403);
 await writeFile('docs/validation/evidence/browser-login-bootstrap-proof.json',JSON.stringify({result:'passed',accounts:2,mobileViewport:390,
  pairing:'native-Happier-v3',approval:'synthetic client using native envelope, not native approval UI',opaqueHttpOnlyCookie:true,
  distinctOperatorKeys:true,deviceBootstrapRequired:true,firstConversationLinked:true,linkReplayIdempotent:true,foreignSessionRejected:true,signedControlsPersisted:2,contentKeysInRelayOrStorage:false,
  limits:['No physical phone or native Happier approval UI tested.','Synthetic accounts only; no model subscription or inference.','Clean-host production bootstrap and independent review remain open.']},null,2)+'\n');
}finally{
 await browser?.close();if(gateway&&gateway.exitCode===null){gateway.kill('SIGTERM');await new Promise(resolve=>gateway.once('exit',resolve));}
 await db.close();await isolated.close();if(configPath)await rm(configPath,{force:true});
}
