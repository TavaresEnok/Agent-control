// Finite deterministic correction fixture, never an official model.
import {writeFile} from 'node:fs/promises';
import {writeThroughExecServer,readThroughExecServer,verifyReadOnlyExecServer} from '/opt/fixture/exec-client.mjs';
import {verifiedLaunch} from '/opt/fixture/verify.mjs';
let launch;
for(let attempt=0;attempt<600;attempt++){try{launch=await verifiedLaunch('execution');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
if(!launch)throw Error('FIXTURE_LAUNCH_MISSING');
const task=JSON.parse(launch.task);let output;
if(launch.role==='programmer'){
 if(JSON.stringify(launch.writePaths)!==JSON.stringify(['src/sum.ts']))throw Error('CORRECTION_FIXTURE_SCOPE_INVALID');
 const correction=task.correction;
 if(correction&&(correction.revision!==1||!Array.isArray(correction.failedEvidenceIds)||correction.failedEvidenceIds.length!==1||!/^[a-f0-9]{64}$/.test(correction.decisionDigest)))throw Error('CORRECTION_FIXTURE_EVIDENCE_MISSING');
 const source=correction?'module.exports = (a, b) => a + b;\n':'module.exports = (a, b) => a - b;\n';
 await writeThroughExecServer(launch.toolsAddress,launch.writePaths,()=>source);
 console.log('R4_CORRECTION_WORKER '+JSON.stringify({revision:correction?.revision??0,failedEvidenceCount:correction?.failedEvidenceIds.length??0,usesFrozenDecision:Boolean(correction)}));
 output='deterministic implementation '+(correction?'corrected':'initial');
}else{
 const content=await readThroughExecServer(launch.toolsAddress,['src/sum.ts']);
 if(!content['src/sum.ts']?.startsWith('module.exports = (a, b) => a '))throw Error('CORRECTION_REVIEW_SOURCE_MISSING');
 await verifyReadOnlyExecServer(launch.toolsAddress);
 // The initial independent structural review deliberately misses the behavior
 // defect; the actual QA assertion is responsible for reproducing it.
 output=JSON.stringify({schemaVersion:1,kind:'review',artifactId:task.artifactId,policyRevision:task.policyRevision,commit:task.commit,tree:task.tree,base:task.base,verdict:'pass',findings:[]});
}
await writeFile('/output/execution-result.json',JSON.stringify({schemaVersion:1,jobId:launch.jobId,output,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600,flag:'wx'});
