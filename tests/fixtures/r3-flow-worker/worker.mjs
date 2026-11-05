// Laboratory substitute: no model CLI, account material, or external requests.
import {readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {verifiedLaunch} from '/opt/fixture/verify.mjs';
let launch;
for(let i=0;i<600;i++){try{launch=await verifiedLaunch('execution');break;}catch{await new Promise(r=>setTimeout(r,100));}}
if(!launch)throw Error('FIXTURE_LAUNCH_MISSING');
if(launch.role==='programmer'&&launch.writePaths.some(p=>p.startsWith('src/hold-')))await new Promise(()=>setInterval(()=>{},1000));
if(process.env.AC_R2_FAIL==='1'&&launch.role==='programmer'){await new Promise(r=>setTimeout(r,8000));process.exit(17);}
if(process.env.AC_R2_HOLD==='1'&&launch.role==='programmer')await new Promise(()=>setInterval(()=>{},1000));
if(launch.role==='programmer'){
 const body=JSON.stringify({paths:launch.writePaths});
 await new Promise((resolve,reject)=>{const req=http.request({host:launch.toolsAddress,port:19493,method:'POST',path:'/',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(Error('FIXTURE_TOOLS_FAILURE')));});req.on('error',reject);req.end(body);});
}
const task=JSON.parse(launch.task);
const output=launch.role==='programmer'?'synthetic implementation':JSON.stringify({schemaVersion:1,kind:'review',artifactId:task.artifactId,policyRevision:task.policyRevision,commit:task.commit,tree:task.tree,base:task.base,verdict:'pass',findings:[]});
await writeFile('/output/execution-result.json',JSON.stringify({schemaVersion:1,jobId:launch.jobId,output,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600,flag:'wx'});
