// Controlled diagnostic only; never run arbitrary input or external models.
import { access,writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
const paths=['/var/run/docker.sock','/run/ac-broker/control.sock','/run/ac-broker/key','/peer/secret','/control/.state/browser-fixture.json'];
const visible=[];
for(const path of paths)try{await access(path);visible.push(path);}catch{}
const network=await new Promise(resolve=>{
 const socket=connect({host:'10.99.99.99',port:5432});socket.setTimeout(300);
 socket.on('connect',()=>{socket.destroy();resolve(true)});
 socket.on('error',()=>resolve(false));socket.on('timeout',()=>{socket.destroy();resolve(false)});
});
await writeFile('/work/probe-result.json',JSON.stringify({visible,network,uid:process.getuid?.()})+'\n');
if(visible.length||network||process.getuid?.()!==10001)process.exit(1);
console.log(JSON.stringify({result:'isolated-probe-passed',synthetic:true}));
