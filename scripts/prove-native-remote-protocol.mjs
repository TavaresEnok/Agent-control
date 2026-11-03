// Offline metadata only. Run exclusively in the no-network disposable compose profile.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'ac-native-protocol-')),token=randomBytes(32).toString('hex');
const children=[];let seq=0;const pending=new Map();
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:root,CODEX_HOME:join(root,'empty-codex'),DO_NOT_TRACK:'1'};
const bin='/native/codex';let stderr='';
const deadline=setTimeout(()=>{for(const c of children)c.kill('SIGKILL');},20000);
function child(args){const c=spawn(bin,args,{cwd:root,env,stdio:['pipe','pipe','pipe']});children.push(c);c.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-16000);});return c;}
try{
 await mkdir(env.CODEX_HOME,{mode:0o700});const tokenFile=join(root,'capability');await writeFile(tokenFile,token,{mode:0o600});
 const exec=child(['exec-server','--listen','ws://127.0.0.1:19491','--ws-auth','capability-token','--ws-token-file',tokenFile,'--linux-sandbox-pid-namespace','inherit']);
 // Single bounded startup poll against a loopback socket; never a model request.
 const {createConnection}=await import('node:net');
 for(let i=0;i<50;i++){
  const ready=await new Promise(ok=>{const s=createConnection({host:'127.0.0.1',port:19491});s.once('connect',()=>{s.destroy();ok(true);});s.once('error',()=>ok(false));});
  if(ready)break;if(i===49)throw Error('EXEC_SERVER_NOT_READY');await new Promise(r=>setTimeout(r,100));
 }
 const app=child(['--no-daemon','app-server']);const lines=createInterface({input:app.stdout});
 lines.on('line',line=>{try{const m=JSON.parse(line),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(String(m.error.message))):p.resolve(m.result);}catch{}});
 app.on('exit',()=>{for(const p of pending.values())p.reject(Error('APP_SERVER_EXITED'));pending.clear();});
 function request(method,params){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});app.stdin.write(JSON.stringify({id,method,params})+'\n');});}
 await request('initialize',{clientInfo:{name:'agent-control-offline',version:'0.1.0'},capabilities:{experimentalApi:true}});
 app.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const added=await request('environment/add',{environmentId:'isolated_tools',execServerUrl:'ws://127.0.0.1:19491',authBearerToken:token,connectTimeoutMs:5000});
 const info=await request('environment/info',{environmentId:'isolated_tools'});assert(info&&typeof info==='object');
 const status=await request('environment/status',{environmentId:'isolated_tools'});assert.equal(status.status,'ready');
 await request('environment/add',{environmentId:'wrong_capability',execServerUrl:'ws://127.0.0.1:19491',authBearerToken:'0'.repeat(64),connectTimeoutMs:1000});
 await assert.rejects(request('environment/info',{environmentId:'wrong_capability'}));
 console.log(JSON.stringify({proof:'official-native-environment-protocol',ready:status.status,authenticatedRegistration:true,wrongCapabilityRejected:true,informationReturned:true,inferencePerformed:false,credentialsMounted:false,network:'none',limits:'Loopback protocol metadata only; no cross-container TLS, tool invocation, model inference or production isolation homologation.'}));
}finally{
 clearTimeout(deadline);for(const c of children)c.kill('SIGKILL');for(const p of pending.values())p.reject(Error('PROOF_CLOSED'));await rm(root,{recursive:true,force:true});
}
