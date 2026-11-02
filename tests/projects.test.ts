import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Projects,ProjectRuntimes} from '../src/projects.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import type {CezarRuntime} from '../src/cezar.ts';

test('project gateway enforces ACL and route and header agreement before creating an app',async()=>{
 const a=randomUUID(),b=randomUUID(),c=randomUUID();let starts=0,apps=0;
 const runtimes=new ProjectRuntimes(async p=>{starts++;return {projectId:p.id,close:async()=>{}} as CezarRuntime;});
 const projects={list:async()=>[{id:a,label:'A',role:'owner'},{id:b,label:'B',role:'viewer'}],authorized:async(_:string,id:string)=>(id===a||id===b)?{id,repo:'/synthetic/'+id}:null} as unknown as Projects;
 const gateway=createProjectGateway({projects,runtimes,defaultProjectId:a,authenticate:async r=>r.headers.get('authorization')?'principal':null,publicFetch:async()=>new Response('public'),appFor:r=>{apps++;return {fetch:()=>Response.json({runtime:r.projectId})};}});
 const req=(path:string,project?:string)=>new Request('http://localhost'+path,{headers:{authorization:'Bearer synthetic',...(project?{'x-agent-control-project':project}:{})}});
 assert.equal((await gateway(req('/api/v1/p/'+c+'/workspace/events'))).status,403);assert.equal(starts,0);assert.equal(apps,0);
 const list=await (await gateway(req('/api/v1/ac/projects',b))).json();assert.equal(list.selectedProjectId,b);assert.equal(list.projects.length,2);
 assert.equal((await gateway(req('/api/v1/p/'+b+'/runs',a))).status,403);assert.equal((await gateway(req('/api/v1/p/'+c+'/runs'))).status,403);
 assert.equal((await (await gateway(req('/api/v1/p/'+b+'/runs'))).json()).runtime,b);
 assert.equal((await (await gateway(req('/api/v1/runs',a))).json()).runtime,a);
 assert.equal((await gateway(new Request('http://localhost/api/v1/runs'))).status,401);
 await runtimes.close();
});

test('runtime creation is single flight and capped with no implicit eviction',async()=>{
 let calls=0,closed=0;const pool=new ProjectRuntimes(async p=>{calls++;return {projectId:p.id,close:async()=>{closed++;}} as CezarRuntime;},2);
 const a={id:randomUUID(),repo:'/a'},b={id:randomUUID(),repo:'/b'},c={id:randomUUID(),repo:'/c'};
 assert.equal((await Promise.all([pool.get(a),pool.get(a)])).length,2);assert.equal(calls,1);
 await pool.get(b);await assert.rejects(pool.get(c),/PROJECT_RUNTIME_LIMIT/);await pool.close();assert.equal(closed,2);
});
