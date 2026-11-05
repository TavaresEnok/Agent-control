import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProjectGateway} from '../src/projects-api.ts';
import {Refusal} from '../src/contracts.ts';

test('managed graph gateway mounts only exact authenticated paths before runtime selection',async()=>{
 let calls=0;
 const gateway=createProjectGateway({projects:{authorized:async()=>{throw Error('unexpected project selection');}} as never,
  runtimes:{} as never,defaultProjectId:'invalid-default',publicFetch:async()=>{throw Error('not public');},appFor:()=>{throw Error('must not start runtime');},
  authenticate:async request=>{if(!request.headers.has('authorization'))return null;if(request.method==='POST'&&request.headers.get('origin')!=='https://control.invalid')throw new Refusal('CROSS_ORIGIN_FORBIDDEN',403);return 'owner';},
  workflowGraphs:async(request,principal)=>{calls++;assert.equal(principal,'owner');return Response.json({method:request.method});}});
 for(const path of ['/api/v1/ac/workflow-graphs','/api/v1/ac/workflow-graphs/validate']){
  const url='https://control.invalid'+path;
  assert.equal((await gateway(new Request(url))).status,401);
  assert.equal((await gateway(new Request(url,{method:'POST',headers:{authorization:'synthetic'}}))).status,403);
  const before=calls;assert.equal((await gateway(new Request(url,{method:'POST',headers:{authorization:'synthetic',origin:'https://control.invalid'}}))).status,200);assert.equal(calls,before+1);
 }
 const before=calls;
 assert.equal((await gateway(new Request('https://control.invalid/api/v1/ac/workflow-graphs/validate/extra',{headers:{authorization:'synthetic'}}))).status,400);
 assert.equal(calls,before);
});
