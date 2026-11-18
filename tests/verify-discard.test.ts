import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {discardPersonalVerification} from '../src/personal-verify-cli.ts';
import {beginPersonalVerification} from '../src/verify-command.ts';

async function installation(activation:'personal'|'locked'='personal'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-discard-cli-')));
 const data=join(root,'data');
 const repo=join(root,'repo');
 const projectId=randomUUID();
 await mkdir(data,{recursive:true,mode:0o700});
 const file=join(root,'instalacao.json');
 await writeFile(file,JSON.stringify({
  schemaVersion:1,mode:'administration-only',activation,
  databaseUrl:'postgresql://127.0.0.1:9/ac_discard_unused',
  dataDirectory:data,
  project:{id:projectId,label:'Descartar',repo,owner:'owner@example.com'},
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
  happier:{upstreamOrigin:'http://127.0.0.1:8766',webOrigin:'http://127.0.0.1:8766',publicServerOrigin:'http://127.0.0.1:8765'},
 })+'\n',{mode:0o600});
 await chmod(file,0o600);
 return {root,data,file,projectId};
}

async function plant(data:string,projectId:string,runId:string){
 const directoryName=`20261117-010203-${runId.slice(0,8)}-seguranca`;
 const project=join(data,'verificacoes',projectId);
 const report=join(project,directoryName);
 const tools=join(project,'ferramentas',runId);
 await mkdir(report,{recursive:true,mode:0o700});
 await mkdir(tools,{recursive:true,mode:0o700});
 await writeFile(join(report,'run.json'),`${JSON.stringify({
  id:runId,directoryName,createdAt:'2026-11-17T01:02:03.000Z',
  counts:{alta:0,media:0,baixa:0,informativa:0},note:'descartar',
 })}\n`,{mode:0o600});
 await writeFile(join(tools,'gitleaks.json'),'{"secret":"x"}\n',{mode:0o600});
 return {report,tools,project};
}

function examSpy(){
 let began=0;
 const begin=async(input:never)=>{
  began+=1;
  return beginPersonalVerification(input);
 };
 return {begin,started:()=>began};
}

test('--descartar apaga o relatório e as ferramentas e não inicia o exame',async()=>{
 const env=await installation();
 const runId=randomUUID();
 try{
  const planted=await plant(env.data,env.projectId,runId);
  const exam=examSpy();
  const idle=await discardPersonalVerification([env.file,env.projectId],exam.begin);
  assert.equal(idle,false);
  assert.equal(exam.started(),0);
  assert.equal((await stat(planted.report)).isDirectory(),true);
  assert.equal((await stat(planted.tools)).isDirectory(),true);
  const discarded=await discardPersonalVerification([env.file,env.projectId,'--descartar',runId],exam.begin);
  assert.equal(discarded,true);
  assert.equal(exam.started(),0);
  await assert.rejects(stat(planted.report));
  await assert.rejects(stat(planted.tools));
  await assert.rejects(
   ()=>discardPersonalVerification([env.file,env.projectId,'--url','http://127.0.0.1:9','--descartar',runId],exam.begin),
   (error:unknown)=>error instanceof Refusal&&error.code==='VERIFY_USAGE',
  );
  assert.equal(exam.started(),0);
  await assert.rejects(
   ()=>discardPersonalVerification([env.file,randomUUID(),'--descartar',runId],exam.begin),
   (error:unknown)=>error instanceof Refusal&&error.code==='NOT_FOUND',
  );
  assert.equal(exam.started(),0);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('--descartar recusa instalação travada e symlink de ferramentas sem apagar o alvo',async()=>{
 const env=await installation('locked');
 const runId=randomUUID();
 try{
  const planted=await plant(env.data,env.projectId,runId);
  const exam=examSpy();
  await assert.rejects(
   ()=>discardPersonalVerification([env.file,env.projectId,'--descartar',runId],exam.begin),
   (error:unknown)=>error instanceof Refusal&&error.code==='PERSONAL_ACTIVATION_REQUIRED',
  );
  assert.equal(exam.started(),0);
  assert.equal((await stat(planted.report)).isDirectory(),true);
  assert.equal((await stat(planted.tools)).isDirectory(),true);
  const personal=await installation('personal');
  try{
   const outside=join(personal.root,'fora');
   await mkdir(outside,{recursive:true});
   await writeFile(join(outside,'gitleaks.json'),'fora\n');
   const project=join(personal.data,'verificacoes',personal.projectId,'ferramentas');
   await mkdir(project,{recursive:true,mode:0o700});
   await symlink(outside,join(project,runId));
   await assert.rejects(
    ()=>discardPersonalVerification([personal.file,personal.projectId,'--descartar',runId],exam.begin),
    (error:unknown)=>error instanceof Refusal&&error.code==='VERIFY_PATH_FORBIDDEN',
   );
   assert.equal(exam.started(),0);
   assert.equal(await readFile(join(outside,'gitleaks.json'),'utf8'),'fora\n');
   assert.equal((await lstat(join(project,runId))).isSymbolicLink(),true);
  }finally{await rm(personal.root,{recursive:true,force:true});}
 }finally{await rm(env.root,{recursive:true,force:true});}
});
