#!/usr/local/bin/node
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
const version=readFileSync('/opt/fixture/r6-version','utf8').trim();if(!['1','2'].includes(version))process.exit(2);
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line),thread='r6-thread-'+version,turn='r6-turn-'+version;
 if(msg.method==='initialize')send({id:msg.id,result:{userAgent:'r6-fixture/'+version}});
 else if(msg.method==='thread/start')send({id:msg.id,result:{thread:{id:thread},model:msg.params.model,modelProvider:'openai',reasoningEffort:msg.params.config.model_reasoning_effort,sandbox:{type:'readOnly',networkAccess:false}}});
 else if(msg.method==='turn/start'){
  send({id:msg.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{threadId:thread,turn:{id:turn,status:'inProgress',items:[]}}});
  const p=JSON.parse(readFileSync('/input/launch.json','utf8')).payload;const tasks=['alpha','beta','gamma'].map(id=>({id,objectiveRef:p.sourceMessageRef,acceptanceRefs:[p.sourceMessageRef],inputRefs:[],outputRefs:['output:'+id],dependsOn:id==='gamma'?['alpha','beta']:[],writePaths:['src/'+id+'/a.ts'],qualityRevision:p.constraints.qualityRevision,targetRef:p.constraints.targetRef,maxCorrections:0}));const text=JSON.stringify({schemaVersion:1,contextId:p.contextId,objectiveRef:p.sourceMessageRef,sourceMessageRef:p.sourceMessageRef,parallelism:2,constraintRefs:[],tasks});
  send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,itemId:'result',delta:text}});
  send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',id:'result',text}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
 } else if(msg.id!==undefined)send({id:msg.id,result:{}});
});
