// Disposable two-container protocol proof. No login, model or provider request.
import {spawn} from 'node:child_process';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createConnection} from 'node:net';
import assert from 'node:assert/strict';
import {lookup} from 'node:dns/promises';
import {startToolForwarder} from '/forwarder.mjs';
const root='/tmp/ac-native-pair',pending=new Map();let seq=0,app,stderr='',forwarder;
await mkdir(root,{mode:0o700});await mkdir(root+'/.codex',{mode:0o700});const token=(await readFile('/runner/exec-token','utf8')).trim();
const deadline=setTimeout(()=>{for(const p of pending.values())p.reject(Error('PROOF_TIMEOUT'));app?.kill('SIGKILL');process.exitCode=1;},20000);
try{
 let ready=false;for(let i=0;i<50;i++){
  ready=await new Promise(ok=>{const s=createConnection({host:'native-tools-proof',port:19493});s.setTimeout(500,()=>{s.destroy();ok(false)});s.once('connect',()=>{s.destroy();ok(true)});s.once('error',()=>ok(false));});
  if(ready)break;await new Promise(r=>setTimeout(r,100));
 }assert(ready,'TOOLS_NOT_READY');
 forwarder=await startToolForwarder((await lookup('native-tools-proof',{family:4})).address);
 app=spawn('/native/codex',['--no-daemon','app-server'],{cwd:root,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:root,CODEX_HOME:root+'/.codex',DO_NOT_TRACK:'1'},stdio:['pipe','pipe','pipe']});
 app.stderr.on('data',bytes=>{stderr=(stderr+String(bytes)).slice(-4000);});
 app.once('error',()=>{for(const p of pending.values())p.reject(Error('APP_FAILED'));pending.clear();});
 app.once('exit',()=>{for(const p of pending.values())p.reject(Error('APP_EXITED'));pending.clear();});
 const lines=createInterface({input:app.stdout});lines.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error('RPC_REFUSED:'+p.method+':'+String(m.error.message).replaceAll(token,'[SYNTHETIC_CAPABILITY]'))):p.resolve(m.result);});
 const request=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,method});app.stdin.write(JSON.stringify({id,method,params})+'\n');});
 await request('initialize',{clientInfo:{name:'agent-control-native-pair-proof',version:'0.1.0'},capabilities:{experimentalApi:true}});app.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 await request('environment/add',{environmentId:'isolated_tools',execServerUrl:'ws://127.0.0.1:19492',authBearerToken:token,connectTimeoutMs:3000});
 assert(await request('environment/info',{environmentId:'isolated_tools'}));assert.equal((await request('environment/status',{environmentId:'isolated_tools'})).status,'ready');
 await request('environment/add',{environmentId:'wrong_capability',execServerUrl:'ws://127.0.0.1:19492',authBearerToken:'0'.repeat(64),connectTimeoutMs:1000});
 await assert.rejects(request('environment/info',{environmentId:'wrong_capability'}));
 console.log(JSON.stringify({proof:'native-two-container-protocol',separateContainers:true,privateNetwork:true,authenticatedToolsReady:true,wrongCapabilityRejected:true,accountsMounted:false,inferencePerformed:false,limits:'Protocol metadata only; no model turn, code mutation, supervisor start path, TLS or production homologation.'}));
}catch(error){console.error(stderr.replaceAll(token,'[SYNTHETIC_CAPABILITY]'));throw error;}
finally{clearTimeout(deadline);forwarder?.close();app?.kill('SIGKILL');for(const p of pending.values())p.reject(Error('PROOF_CLOSED'));await rm(root,{recursive:true,force:true});}
