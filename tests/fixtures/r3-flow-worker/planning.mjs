// Deterministic inference substitute; product supervisor owns admission/receipt.
import {readFile,writeFile} from 'node:fs/promises';
import {verifiedLaunch} from '/opt/fixture/verify.mjs';
const p=await verifiedLaunch('planning');
const tasks=['alpha','beta','gamma'].map(id=>({id,objectiveRef:p.sourceMessageRef,acceptanceRefs:[p.sourceMessageRef],inputRefs:[],outputRefs:['output:'+id],dependsOn:id==='gamma'?['alpha','beta']:[],writePaths:['src/'+id+'/a.ts'],qualityRevision:p.constraints.qualityRevision,targetRef:p.constraints.targetRef,maxCorrections:0}));
const output=JSON.stringify({schemaVersion:1,contextId:p.contextId,objectiveRef:p.sourceMessageRef,sourceMessageRef:p.sourceMessageRef,parallelism:2,constraintRefs:[],tasks});
await writeFile('/output/planning-result.json',JSON.stringify({schemaVersion:1,callId:p.callId,output,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null,exitCode:0}),{mode:0o600,flag:'wx'});
