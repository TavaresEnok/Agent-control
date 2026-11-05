// Deterministic review inference fixture. Actual immutable artifact bytes are read by the isolated tools pair.
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readArtifactThroughExecServer} from '/opt/fixture/exec-client.mjs';
import {verifiedLaunch} from '/opt/fixture/verify.mjs';
let launch;for(let attempt=0;attempt<200;attempt++){try{launch=await verifiedLaunch('execution');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
if(!launch||!['reviewer','judge'].includes(launch.role))throw Error('REMOTE_QUALITY_SIGNED_REVIEW_LAUNCH_REQUIRED');
const canary=(await readFile('/runner/exec-token','utf8')).trim();
process.stdout.write('CANARY_BEFORE '+canary.slice(0,12));await new Promise(resolve=>setTimeout(resolve,100));process.stdout.write(canary.slice(12)+' CANARY_AFTER\n');
const task=JSON.parse(launch.task);
const content=await readArtifactThroughExecServer(launch.toolsAddress),observation={content,sha256:createHash('sha256').update(content).digest('hex')};
if(content!=='export const value = 2;\n')throw Error('DETERMINISTIC_INDEPENDENT_REVIEW_REJECTED');
const output=JSON.stringify({schemaVersion:1,kind:task.kind,artifactId:task.artifactId,policyRevision:task.policyRevision,commit:task.commit,tree:task.tree,base:task.base,verdict:'pass',findings:[]});
console.log(JSON.stringify({kind:'deterministic-independent-review',role:launch.role,artifactCommit:task.commit,readOnlyArtifactSha256:observation.sha256,modelInference:false}));
await writeFile('/output/execution-result.json',JSON.stringify({schemaVersion:1,jobId:launch.jobId,output,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600,flag:'wx'});
