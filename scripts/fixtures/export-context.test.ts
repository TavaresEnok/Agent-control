import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import nacl from 'tweetnacl';
import {Ledger} from '../../src/ledger.ts';
import {loadHappier} from '../../src/happier.ts';

test('export-context CLI exports encrypted canonical history from the isolated Happier server', {timeout:60000}, async()=>{
 const url=process.env.AC_TEST_DATABASE_URL,base=process.env.AC_TEST_HAPPIER_URL;
 if(!url || !base || new URL(base).hostname!=='127.0.0.1') throw Error('ISOLATED_FIXTURE_REQUIRED');
 const root=await mkdtemp(join(tmpdir(),'ac-export-cli-')),db=new Ledger(url);
 try{
  await db.migrate();const key=randomBytes(32),pair=nacl.sign.keyPair.fromSeed(key),challenge=randomBytes(32),b64=(v:Uint8Array)=>Buffer.from(v).toString('base64');
  const auth=await fetch(base+'/v1/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:b64(pair.publicKey),challenge:b64(challenge),signature:b64(nacl.sign.detached(challenge,pair.secretKey))})});assert.equal(auth.status,200);
  const {token}=await auth.json() as {token:string};
  async function api(path:string,body?:unknown):Promise<any>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(r.ok,true,`${path}: ${r.status}`);return r.json();}
  const principal=(await api('/v1/account/profile')).id,b=await loadHappier(),seal=(v:unknown)=>b.encodeBase64(b.encrypt(key,'legacy',v)),machine=randomUUID();
  await api('/v1/machines',{id:machine,metadata:seal({host:'fixture',platform:'linux',happyCliVersion:'0.2.18',homeDir:'/tmp/fixture'}),daemonState:seal({status:'running',startedAt:Date.now()})});
  const session=(await api('/v1/sessions',{tag:'export-'+randomUUID(),encryptionMode:'e2ee',metadata:seal({machineId:machine,path:'/tmp/fixture',host:'fixture',homeDir:'/tmp/fixture',version:'0.2.18',name:'Export',flavor:'claude',startedBy:'terminal',startedFromDaemon:false}),agentState:seal({controlledByUser:false,requests:{},completedRequests:{}})})).session.id;
  const plaintext='synthetic-export-message',ciphertext=seal({role:'user',content:{type:'text',text:plaintext}});
  await api(`/v2/sessions/${session}/messages`,{ciphertext,localId:randomUUID()});
  const project=randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Export fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,session);
  const repo=join(root,'repo'),privateDir=join(root,'private');await mkdir(repo);await mkdir(privateDir,{mode:0o700});
  const config={schemaVersion:1,mode:'administration-only',databaseUrl:url,dataDirectory:join(root,'state'),project:{id:project,label:'Export fixture',repo,owner:principal},projects:[],http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},happier:{upstreamOrigin:base,webOrigin:base,publicServerOrigin:base}};
  const configPath=join(privateDir,'config.json'),tokenPath=join(privateDir,'token'),descriptorPath=join(privateDir,'descriptor.json'),outputPath=join(privateDir,'export.json');
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});await writeFile(tokenPath,token,{mode:0o600});await writeFile(descriptorPath,JSON.stringify({contextId:context,tokenFile:tokenPath,outputFile:outputPath}),{mode:0o600});
  const output=execFileSync(process.execPath,['--import','tsx',resolve('src/server-main.ts'),'export-context',configPath,descriptorPath],{encoding:'utf8'});
  assert.equal(JSON.parse(output).state,'exported');const result=JSON.parse(await readFile(outputPath,'utf8'));assert.equal(result.messages.length,1);assert.equal(result.messages[0].ciphertext,ciphertext);assert.equal(result.keysIncluded,false);assert.equal(result.restorable,false);assert(!JSON.stringify(result).includes(plaintext));assert.equal((await stat(outputPath)).mode&0o777,0o600);
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
