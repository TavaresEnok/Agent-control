import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProjectAdminApi} from '../src/project-admin-api.ts';
import type {ProjectAdmin} from '../src/project-admin.ts';
const service={} as ProjectAdmin;
const proof=Buffer.from(JSON.stringify({deviceId:'00000000-0000-4000-8000-000000000001',expiresAt:1,signature:'a'.repeat(128)})).toString('base64url');
const handler=createProjectAdminApi(service,{bodyTimeoutMs:20});
const headers={'x-ac-operator-proof':proof,'content-type':'application/json'};
test('administrative body is bounded, JSON-only and has a read deadline',async()=>{
 const request=(body:BodyInit,extra:Record<string,string>={})=>new Request('http://localhost/api/v1/ac/project-admin',{method:'POST',headers:{...headers,...extra},body,duplex:'half'} as RequestInit & {duplex:'half'});
 assert.equal((await handler(request('{}',{'content-type':'text/plain'}),'fixture')).status,415);
 assert.equal((await handler(request('{}',{'content-encoding':'gzip'}),'fixture')).status,415);
 assert.equal((await handler(request('x'.repeat(16385)),'fixture')).status,413);
 const stalled=new ReadableStream<Uint8Array>({start(){}});
 assert.equal((await handler(request(stalled),'fixture')).status,408);
});

test('gateway authenticates before routing only the exact global administrative endpoint',async()=>{
 const {createProjectGateway}=await import('../src/projects-api.ts');
 let calls=0,selected=0;
 const gateway=createProjectGateway({projects:{authorized:async()=>{selected++;return null;}} as never,runtimes:{} as never,
  defaultProjectId:'00000000-0000-4000-8000-000000000001',appFor:()=>{throw Error('unexpected runtime');},publicFetch:async()=>new Response('public'),
  authenticate:async request=>request.headers.get('x-test-principal'),projectAdmin:async(_request,principal)=>{calls++;return Response.json({principal});}});
 const target='http://localhost/api/v1/ac/project-admin';
 assert.equal((await gateway(new Request(target))).status,401);assert.equal(calls,0);
 const response=await gateway(new Request(target,{headers:{'x-test-principal':'fixture'}}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{principal:'fixture'});assert.equal(calls,1);assert.equal(selected,0);
 assert.equal((await gateway(new Request(target+'/extra',{headers:{'x-test-principal':'fixture'}}))).status,403);assert.equal(calls,1);
});
