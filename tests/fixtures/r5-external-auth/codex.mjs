#!/usr/bin/env node
// Deterministic JSON-RPC substitute; no provider authentication or network.
import {createInterface} from 'node:readline';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');let account,turn='t';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return emit({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='initialized')return;
 if(m.method==='account/login/start'){account=m.params.chatgptAccountId;if(m.params.type!=='chatgptAuthTokens'||!m.params.accessToken||!account)return emit({id:m.id,error:{code:-32602,message:'bad auth'}});return emit({id:m.id,result:{type:'chatgptAuthTokens'}});}
 if(m.method==='environment/add')return emit({id:m.id,result:{}});
 if(m.method==='environment/info')return emit({id:m.id,result:{cwd:'/work',shell:'/bin/sh'}});
 if(m.method==='environment/status')return emit({id:m.id,result:{status:'ready'}});
 if(m.method==='thread/start'){emit({method:'thread/started',params:{thread:{id:'th'}}});return emit({id:m.id,result:{thread:{id:'th',environments:m.params.environments},model:m.params.model,modelProvider:'openai',reasoningEffort:m.params.config.model_reasoning_effort,sandbox:{type:'dangerFullAccess',networkAccess:false}}});}
 if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:turn}}});emit({method:'turn/started',params:{threadId:'th',turn:{id:turn,status:'inProgress',items:[]}}});return emit({id:'refresh-1',method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized',previousAccountId:account}});}
 if(m.id==='refresh-1'){
  if(m.error){emit({method:'turn/completed',params:{turn:{id:turn,status:'failed',error:{message:'synthetic refresh denied'}}}});return;}
  if(!m.result?.accessToken||m.result.chatgptAccountId!==account)process.exit(4);
  const text='before '+m.result.accessToken+' after';emit({method:'item/started',params:{threadId:'th',turnId:turn,item:{type:'agentMessage',id:'i',text:''}}});
  emit({method:'item/agentMessage/delta',params:{threadId:'th',turnId:turn,itemId:'i',delta:text.slice(0,18)}});emit({method:'item/agentMessage/delta',params:{threadId:'th',turnId:turn,itemId:'i',delta:text.slice(18)}});
  emit({method:'item/completed',params:{threadId:'th',turnId:turn,item:{type:'agentMessage',id:'i',text}}});return emit({method:'turn/completed',params:{turn:{id:turn,status:'completed'}}});
 }
});
