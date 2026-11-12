import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Refusal} from '../src/contracts.ts';
import {runPersonalQaCli} from '../src/personal-qa-cli.ts';
import {readPersonalQaConfig} from '../src/personal-qa-config.ts';

async function installation(){
 const root=await mkdtemp(join(tmpdir(),'qa-cli-'));
 const data=join(root,'data'),repo=join(root,'repo'),id=randomUUID();
 await mkdir(data,{recursive:true,mode:0o700});
 const file=join(data,'installation.json');
 await writeFile(file,JSON.stringify({schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:'postgresql://127.0.0.1:5432/ac',dataDirectory:data,
  project:{id,label:'IspAgent',repo,owner:'owner@example.com'},projects:[{id:randomUUID(),label:'outro',repo:join(root,'other'),owner:'owner@example.com'}],
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
  happier:{upstreamOrigin:'http://127.0.0.1:8766',webOrigin:'http://127.0.0.1:8766',publicServerOrigin:'http://127.0.0.1:8765'}},null,2)+'\n',{mode:0o600});
 return {root,data,file,id};
}

test('personal:qa set validates, writes mode 600 and tells the owner to restart',async()=>{
 const env=await installation();
 try{
  await assert.rejects(()=>runPersonalQaCli([env.file,'IspAgent','set','--test','"npm test"']),(error:unknown)=>error instanceof Refusal&&error.code==='QA_CONFIG_NOT_A_LIST');
  await assert.rejects(()=>runPersonalQaCli([env.file,'IspAgent','set','--test','["bash","-lc","npm test"]']),(error:unknown)=>error instanceof Refusal&&error.code==='QA_COMMAND_NOT_ALLOWED');
  await assert.rejects(()=>runPersonalQaCli([env.file,'IspAgent','set','--test','["npm","test"]','--timeout','10']),(error:unknown)=>error instanceof Refusal&&error.code==='QA_TIMEOUT_OUT_OF_RANGE');
  const lines=await runPersonalQaCli([env.file,env.id,'set','--prepare','["corepack","pnpm","install","--frozen-lockfile"]','--test','["corepack","pnpm","--filter","@ispagent/shared","test"]','--timeout','600']);
  assert.match(lines.at(-1)??'',/Reinicie o gateway/);
  assert.equal((await stat(join(env.data,'qa',env.id+'.json'))).mode&0o777,0o600);
  const saved=await readPersonalQaConfig(env.data,env.id);
  assert.deepEqual(saved?.test,['corepack','pnpm','--filter','@ispagent/shared','test']);
  assert.equal(saved?.services,undefined);
  const shown=await runPersonalQaCli([env.file,'IspAgent','show']);
  assert.match(shown[0]??'',/@ispagent\/shared/);
  const cleared=await runPersonalQaCli([env.file,'IspAgent','clear']);
  assert.match(cleared[0]??'',/removido/);
  assert.match(cleared.at(-1)??'',/Reinicie o gateway/);
  assert.equal(await readPersonalQaConfig(env.data,env.id),null);
  const again=await runPersonalQaCli([env.file,'IspAgent','show']);
  assert.match(again[0]??'',/QA padrão/);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('personal:qa set stores a postgres service and refuses an invalid one',async()=>{
 const env=await installation();
 try{
  await assert.rejects(()=>runPersonalQaCli([env.file,'IspAgent','set','--test','["npm","test"]','--services','not-json']),(error:unknown)=>error instanceof Refusal&&error.code==='QA_SERVICES_INVALID');
  await assert.rejects(()=>runPersonalQaCli([env.file,'IspAgent','set','--test','["npm","test"]','--services','{"postgres":{"image":"postgres:18-alpine","database":"qa_test"}}']),(error:unknown)=>error instanceof Refusal&&error.code==='QA_SERVICES_INVALID');
  await assert.rejects(()=>runPersonalQaCli([env.file,'IspAgent','set','--test','["npm","test"]','--services','{"postgres":{"image":"postgres:16-alpine","database":"qa_test","password":"secret"}}']),(error:unknown)=>error instanceof Refusal&&error.code==='QA_SERVICES_INVALID');
  const lines=await runPersonalQaCli([env.file,'IspAgent','set','--test','["npm","test"]','--services','{"postgres":{"image":"postgres:16-alpine","database":"qa_test"}}']);
  assert.match(lines.at(-1)??'',/Reinicie o gateway/);
  const saved=await readPersonalQaConfig(env.data,env.id);
  assert.deepEqual(saved?.services,{postgres:{image:'postgres:16-alpine',database:'qa_test'}});
  assert.equal(JSON.stringify(saved).includes('password'),false);
  const shown=await runPersonalQaCli([env.file,'IspAgent','show']);
  assert.match(shown[0]??'',/postgres:16-alpine/);
  assert.equal((shown[0]??'').includes('password'),false);
 }finally{await rm(env.root,{recursive:true,force:true});}
});
