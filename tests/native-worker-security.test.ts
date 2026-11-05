import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,appendFile,open,chmod,symlink,link,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {canonical,digest} from '../src/contracts.ts';
import {assertCodexSubscriptionIdentity,readPrivateWorkerFile,readSignedWorkerLaunch} from '../src/native-worker-security.ts';

test('private worker input refuses links, non-regular files and oversized content',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-worker-hostile-'));
 try{
  const file=join(dir,'input'),alias=join(dir,'alias');
  await writeFile(file,'synthetic',{mode:0o600});
  assert.equal((await readPrivateWorkerFile(file,9)).toString(),'synthetic');
  await assert.rejects(readPrivateWorkerFile(file,8),/INVALID_WORKER_PRIVATE_FILE/);
  await symlink(file,alias);await assert.rejects(readPrivateWorkerFile(alias,100));await rm(alias);
  await link(file,alias);await assert.rejects(readPrivateWorkerFile(file,100),/INVALID_WORKER_PRIVATE_FILE/);await rm(alias);
  await assert.rejects(readPrivateWorkerFile(dir,100),/INVALID_WORKER_PRIVATE_FILE/);
  await assert.rejects(readPrivateWorkerFile(file,-1),/INVALID_WORKER_PRIVATE_FILE/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('private worker read rejects a file that grows after stat',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-worker-race-')),file=join(dir,'input');
 let prototype:any,original:any;
 try{
  await writeFile(file,'small',{mode:0o600});
  const probe=await open(file,'r');prototype=Object.getPrototypeOf(probe);original=prototype.stat;await probe.close();
  // Test-only barrier: grow the file after the descriptor's actual stat, before
  // the caller resumes and reads. No hooks are exposed by the worker.
  let intercepted=false;
  prototype.stat=async function(...args:unknown[]){const info=await original.apply(this,args);if(!intercepted){intercepted=true;await appendFile(file,'-over-limit');}return info;};
  await assert.rejects(readPrivateWorkerFile(file,5),/INVALID_WORKER_PRIVATE_FILE/);
  assert.equal(intercepted,true);
 }finally{if(prototype&&original)prototype.stat=original;await rm(dir,{recursive:true,force:true});}
});

test('worker accepts only a signed scoped request and the matching private subscription identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-worker-security-'));
 try{
  const schema=z.object({job:z.string(),epoch:z.number().int().positive()}).strict(),payload={job:'synthetic',epoch:2},domain='fixture:worker:v1';
  const keys=generateKeyPairSync('ed25519'),input=join(dir,'launch.json'),publicKey=join(dir,'public.pem');
  await writeFile(publicKey,keys.publicKey.export({type:'spki',format:'pem'}));
  const signature=sign(null,Buffer.from(domain+'\n'+canonical(payload)),keys.privateKey).toString('hex');
  await writeFile(input,JSON.stringify({payload,signature}),{mode:0o600});
  assert.deepEqual(await readSignedWorkerLaunch(schema,domain,input,publicKey),payload);
  await assert.rejects(readSignedWorkerLaunch(schema,'fixture:other',input,publicKey),/INVALID_WORKER_SIGNATURE/);
  await writeFile(input,JSON.stringify({payload:{...payload,epoch:3},signature}));
  await assert.rejects(readSignedWorkerLaunch(schema,domain,input,publicKey),/INVALID_WORKER_SIGNATURE/);
  await chmod(input,0o644);await assert.rejects(readSignedWorkerLaunch(schema,domain,input,publicKey),/INVALID_WORKER_PRIVATE_FILE/);
  const account=join(dir,'account'),codex=join(account,'.codex');await mkdir(account,{mode:0o700});await mkdir(codex,{mode:0o700});
  const auth=join(codex,'auth.json'),expected=digest({provider:'codex',subject:'synthetic-account'});
  await writeFile(auth,JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'synthetic-account',access_token:'fixture',refresh_token:'fixture',id_token:'synthetic-id-token'}}),{mode:0o600});
  assert((await assertCodexSubscriptionIdentity(expected,account)).secrets.includes('synthetic-id-token'));
  await assert.rejects(assertCodexSubscriptionIdentity('a'.repeat(64),account),/WORKER_ACCOUNT_IDENTITY_MISMATCH/);
  await symlink(join(dir,'missing-target'),join(codex,'config.toml'));
  await assert.rejects(assertCodexSubscriptionIdentity(expected,account),/CUSTOM_CODEX_CONFIG_FORBIDDEN/);
  await rm(join(codex,'config.toml'));await chmod(auth,0o644);
  await assert.rejects(assertCodexSubscriptionIdentity(expected,account),/INVALID_WORKER_PRIVATE_FILE/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('tool forwarding accepts only private IPv4 destinations and refuses local or public targets before binding',async()=>{
 const {isPrivateToolAddress,startToolForwarder}=await import('../src/native-tool-forwarder.ts');
 for(const value of ['10.12.1.4','172.16.0.8','172.31.9.2','192.168.4.7'])assert.equal(isPrivateToolAddress(value),true);
 for(const value of ['127.0.0.1','169.254.1.1','172.32.0.1','8.8.8.8','::1','localhost','10.2.3.999']){
  assert.equal(isPrivateToolAddress(value),false);await assert.rejects(startToolForwarder(value),/INVALID_TOOL_ADDRESS/);
 }
});

test('native external auth refuses a changed credential snapshot and uses a private child home',async()=>{
 const {prepareNativeExternalAuth}=await import('../src/native-worker-security.ts');const {createHmac,randomBytes}=await import('node:crypto');const {canonical}=await import('../src/contracts.ts');const {buildCodexAppServerEnv}=await import('../upstream/cezar/packages/cezar/dist/core/codex-app-server-transport.js');
 const root=await mkdtemp('/tmp/ac-native-auth-home-'),token=randomBytes(32).toString('hex'),secrets=['fixture-access-token','fixture-refresh-token'],tag=createHmac('sha256',token).update(canonical(secrets)).digest('hex');
 try{await assert.rejects(prepareNativeExternalAuth(['changed-access-token',secrets[1]!],token,tag,root),/WORKER_CREDENTIAL_SNAPSHOT_CHANGED/);const privateHome=await prepareNativeExternalAuth(secrets,token,tag,root);assert.equal((await lstat(privateHome)).mode&0o777,0o700);const prior=process.env.CODEX_HOME;process.env.CODEX_HOME=privateHome;let env:NodeJS.ProcessEnv;try{env=buildCodexAppServerEnv();}finally{if(prior===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prior;}assert.equal(env.CODEX_HOME,privateHome);assert(!privateHome.includes('/account/.codex'));}finally{await rm(root,{recursive:true,force:true});}
});
