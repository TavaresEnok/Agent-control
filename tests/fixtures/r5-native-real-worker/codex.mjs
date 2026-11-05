#!/usr/bin/env node
// The real public exec-server is preserved for tools; app-server is a fully
// local deterministic protocol fixture, never provider inference.
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
if(process.argv.includes('exec-server')){const child=spawn('/opt/fixture/public-codex',process.argv.slice(2),{stdio:'inherit'});child.once('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exit(code??1);});}
else{
 const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');let accessToken='';
 createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
  if(m.method==='initialize')return emit({id:m.id,result:{userAgent:'synthetic-app-server'}});
  if(m.method==='initialized')return;
  if(m.method==='account/login/start'){if(m.params.type!=='chatgptAuthTokens'||!m.params.accessToken)return emit({id:m.id,error:{code:-32602,message:'bad fixture auth'}});accessToken=m.params.accessToken;return emit({id:m.id,result:{type:'chatgptAuthTokens'}});}
  if(m.method==='environment/add')return emit({id:m.id,result:{}});
  if(m.method==='environment/info')return emit({id:m.id,result:{cwd:'/work',shell:'/bin/sh'}});
  if(m.method==='environment/status')return emit({id:m.id,result:{status:'ready'}});
  if(m.method==='thread/start'){emit({method:'thread/started',params:{thread:{id:'th'}}});return emit({id:m.id,result:{thread:{id:'th',environments:m.params.environments},model:m.params.model,modelProvider:'openai',reasoningEffort:m.params.config.model_reasoning_effort,sandbox:{type:'dangerFullAccess',networkAccess:false}}});}
  if(m.method==='turn/start'){
   const prompt=m.params.input.map(value=>value.text??'').join('\n');if(!prompt.includes('Do not change files')||prompt.includes(accessToken))throw Error('PROMPT_CREDENTIAL_BOUNDARY_INVALID');const user=prompt.split('\n\n---\n\n').at(-1),request=JSON.parse(JSON.parse(user).request);
   const text=JSON.stringify({schemaVersion:1,kind:request.kind,artifactId:request.artifactId,policyRevision:request.policyRevision,commit:request.commit,tree:request.tree,base:request.base,verdict:'pass',findings:[{severity:'low',summary:'before '+accessToken+' after'}]});
   emit({id:m.id,result:{turn:{id:'t'}}});emit({method:'turn/started',params:{threadId:'th',turn:{id:'t',status:'inProgress',items:[]}}});emit({method:'item/started',params:{threadId:'th',turnId:'t',item:{type:'agentMessage',id:'i',text:''}}});
   const cut=text.indexOf(accessToken)+Math.floor(accessToken.length/2);emit({method:'item/agentMessage/delta',params:{threadId:'th',turnId:'t',itemId:'i',delta:text.slice(0,cut)}});emit({method:'item/agentMessage/delta',params:{threadId:'th',turnId:'t',itemId:'i',delta:text.slice(cut)}});
   emit({method:'item/completed',params:{threadId:'th',turnId:'t',item:{type:'agentMessage',id:'i',text}}});return emit({method:'turn/completed',params:{turn:{id:'t',status:'completed'}}});
  }
 });
}
