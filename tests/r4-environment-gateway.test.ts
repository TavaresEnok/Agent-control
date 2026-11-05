import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProjectGateway} from '../src/projects-api.ts';
import {Refusal} from '../src/contracts.ts';

test('global environment route requires authentication and origin check before dispatch without starting a runtime',async()=>{
 let calls=0;
 const gateway=createProjectGateway({projects:{authorized:async()=>{throw Error('unexpected project selection');}} as never,
  runtimes:{} as never,defaultProjectId:'invalid-selection-is-not-an-authority',
  publicFetch:async()=>{throw Error('unexpected public route');},appFor:()=>{throw Error('unexpected runtime');},
  authenticate:async request=>{if(!request.headers.has('authorization'))return null;if(request.headers.get('origin')!=='https://control.invalid')throw new Refusal('ORIGIN_FORBIDDEN',403);return 'owner';},
  projectEnvironments:async(_request,principal)=>{calls++;assert.equal(principal,'owner');return Response.json({ok:true});}});
 const url='https://control.invalid/api/v1/ac/project-admin/environments';
 assert.equal((await gateway(new Request(url))).status,401);
 assert.equal((await gateway(new Request(url,{method:'POST',headers:{authorization:'synthetic'}}))).status,403);
 assert.equal(calls,0);
 assert.equal((await gateway(new Request(url,{headers:{authorization:'synthetic',origin:'https://control.invalid'}}))).status,200);
 assert.equal(calls,1);
 assert.equal((await gateway(new Request(url+'/suffix',{headers:{authorization:'synthetic',origin:'https://control.invalid'}}))).status,400);
 assert.equal(calls,1);
});
