// Fixed, hash-verified laboratory payload. No real account or provider traffic.
import {readFile,writeFile,symlink,unlink} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {connect} from 'node:net'
import assert from 'node:assert/strict'
const targets=JSON.parse(await readFile('/work/targets.json','utf8'))
const checks=[]
async function deny(label,action){let refused=false;try{await action()}catch{refused=true}assert(refused,label+' unexpectedly succeeded');checks.push(label)}
assert.equal(process.getuid(),10001)
assert.equal(await readFile('/work/own-canary','utf8'),targets.ownCanary)
await writeFile('/work/legitimate-output','authorized local worker output\n')
checks.push('own-work-read-write-control')
for(const [index,path] of targets.foreignPaths.entries()){
 await deny('read-'+index,()=>readFile(path))
 await deny('write-'+index,()=>writeFile(path,'unauthorized overwrite\n'))
 const link='/work/foreign-link';await symlink(path,link)
 await deny('symlink-read-'+index,()=>readFile(link))
 await deny('symlink-write-'+index,()=>writeFile(link,'unauthorized overwrite\n'));await unlink(link)
 // Shell sees precisely the same targets and cannot turn a denied read into authority.
 await deny('shell-'+index,async()=>execFileSync('/bin/sh',['-c','cat "$1"; printf attack > "$1"','probe',path],{stdio:'pipe',timeout:1000}))
}
await deny('signal-host-process',async()=>process.kill(targets.hostPid,'SIGTERM'))
await deny('host-proc-mem',()=>readFile(`/proc/${targets.hostPid}/mem`))
for(const path of targets.sockets){
 await deny('socket-'+checks.length,()=>new Promise((resolve,reject)=>{const s=connect(path);s.setTimeout(500);s.once('connect',()=>{s.destroy();resolve()});s.once('error',reject);s.once('timeout',()=>{s.destroy();reject(Error('timeout'))})}))
}
await deny('central-http-network',async()=>{await fetch(targets.centralUrl,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(750)})})
const pidNamespace=(await readFile('/proc/self/status','utf8')).match(/^NSpid:\s+(.+)$/m)?.[1]??'unavailable'
await writeFile('/work/attack-ready.json',JSON.stringify({checks,pidNamespace,uid:process.getuid(),synthetic:true}))
for(let i=0;i<300;i++){try{await readFile('/work/release');break}catch{if(i===299)throw Error('CONTROLLER_RELEASE_TIMEOUT');await new Promise(r=>setTimeout(r,100))}}
await writeFile('/work/probe-result.json',JSON.stringify({visible:[],network:false,uid:process.getuid()}))
console.log(JSON.stringify({result:'bounded-hostile-probe-passed',checkCount:checks.length,synthetic:true}))
