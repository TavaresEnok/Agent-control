import WebSocket from 'ws';
import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
/** Deterministic inference drives actual local Codex exec-server FS RPCs. */
export async function writeThroughExecServer(address,paths,contentFor=(path)=>'// synthetic '+path+'\n'){
 await withServer(address,async rpc=>{
  for(const path of paths){
   if(!/^src\/[a-z0-9/_-]+\.ts$/.test(path))throw Error('FIXTURE_WRITE_SCOPE_INVALID');
   await rpc('fs/createDirectory',{path:'file:///work/'+posix.dirname(path),recursive:true});
   const text=contentFor(path);if(typeof text!=='string'||Buffer.byteLength(text)>262144)throw Error('FIXTURE_WRITE_CONTENT_INVALID');await rpc('fs/writeFile',{path:'file:///work/'+path,dataBase64:Buffer.from(text).toString('base64')});
   const observed=await rpc('fs/readFile',{path:'file:///work/'+path});if(Buffer.from(observed.dataBase64,'base64').toString()!==text)throw Error('EXEC_SERVER_WRITE_NOT_OBSERVED');
  }
 });console.log('R3_REAL_EXEC_SERVER_WRITE_READ_OK');
}
export async function readThroughExecServer(address,paths){
 const contents={};await withServer(address,async rpc=>{for(const path of paths){
  if(!/^src\/[a-z0-9/_-]+\.ts$/.test(path))throw Error('FIXTURE_READ_SCOPE_INVALID');
  const result=await rpc('fs/readFile',{path:'file:///work/'+path});contents[path]=Buffer.from(result.dataBase64,'base64').toString();
 }});console.log('R4_REAL_EXEC_SERVER_REVIEW_READ_OK');return contents;
}
export async function verifyReadOnlyExecServer(address){
 await withServer(address,async rpc=>{try{await rpc('fs/writeFile',{path:'file:///work/.r3-evaluator-write',dataBase64:'bm90IGFsbG93ZWQ='});throw Error('EVALUATOR_WRITE_ACCEPTED');}catch(error){if(!/Read-only file system/i.test(error.message))throw error;}});
 console.log('R3_REAL_EXEC_SERVER_READONLY_DENIED');
}
async function withServer(address,operation){
 const token=(await readFile('/runner/exec-token','utf8')).trim();if(!/^[A-Za-z0-9._~-]{32,512}$/.test(token))throw Error('FIXTURE_TOOL_CAPABILITY_INVALID');
 let socket;for(let attempt=0;attempt<30;attempt++){
  try{socket=await connect(address,token);break;}catch(error){if(attempt===29)throw error;await new Promise(resolve=>setTimeout(resolve,100));}
 }
 let seq=0;const pending=new Map();
 socket.on('message',data=>{const message=JSON.parse(data.toString());if(message.id!==undefined){const entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error('EXEC_SERVER_RPC_'+message.error.code+'_'+message.error.message)):entry.resolve(message.result);}}});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('EXEC_SERVER_RPC_TIMEOUT'));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 try{
  try{const wrong=await connect(address,token+'-wrong');wrong.close();throw Error('INVALID_TOOL_CAPABILITY_ACCEPTED');}catch(error){if(!/Unexpected server response: (401|403)/.test(error.message))throw error;}
  console.log('R3_REAL_EXEC_SERVER_BAD_CAPABILITY_REFUSED');
  await rpc('initialize',{clientName:'ac-r3-flow-deterministic',clientVersion:'1'});socket.send(JSON.stringify({method:'initialized',params:{}}));
  try{await rpc('fs/readFile',{path:'file:///account/r3-secret-canary'});throw Error('TOOLS_ACCOUNT_HOME_VISIBLE');}catch(error){if(!/No such file or directory/i.test(error.message))throw error;}
  await operation(rpc);
 }finally{socket.close();for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('EXEC_SERVER_CLOSED'));}pending.clear();}
}
function connect(address,token){return new Promise((resolve,reject)=>{const socket=new WebSocket('ws://'+address+':19493',{headers:{authorization:'Bearer '+token},handshakeTimeout:1000});socket.once('open',()=>resolve(socket));socket.once('error',reject);});}
