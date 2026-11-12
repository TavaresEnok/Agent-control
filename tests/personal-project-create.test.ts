import {describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,realpath,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {addPersonalProject} from '../src/personal-project-add.ts';
import {createPersonalProject} from '../src/personal-panel-projects.ts';

describe('personal project create',{concurrency:false},()=>{
test('two simultaneous personal project creates: the second is busy',async()=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'ac-create-')));
 let calls=0,release:()=>void=()=>{},started:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const startedGate=new Promise<void>(resolve=>{started=resolve;});
 const addPersonalProject=async()=>{calls++;started();await gate;return {projectId:'11111111-1111-4111-8111-111111111111'};};
 const input={installationPath:join(directory,'installation.json'),roots:[{id:'projects',label:'Projetos',path:directory}],rootId:'projects',relativePath:'',label:'Novo',underSystemd:false,addPersonalProject};
 try{
  const first=createPersonalProject(input);
  const second=assert.rejects(createPersonalProject(input),/PROJECT_CREATION_BUSY/);
  await startedGate;
  await second;
  release();
  const created=await first;
  assert.equal(calls,1);
  assert.equal(created.projectId,'11111111-1111-4111-8111-111111111111');
  assert.equal(created.restarting,false);
  assert.equal(created.restartRequired,true);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a folder swapped outside the root before registration is forbidden',async()=>{
 const parent=await realpath(await mkdtemp(join(tmpdir(),'ac-toctou-')));
 const root=join(parent,'root'),outside=join(parent,'outside'),project=join(root,'project');
 await mkdir(project,{recursive:true});
 await mkdir(outside,{recursive:true});
 execFileSync('git',['init','-q','-b','main',outside],{stdio:'ignore'});
 execFileSync('git',['-C',outside,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','base'],{stdio:'ignore'});
 try{
  await assert.rejects(()=>createPersonalProject({
   installationPath:join(parent,'installation.json'),roots:[{id:'projects',label:'Projetos',path:root}],rootId:'projects',relativePath:'project',label:'Fora',underSystemd:false,
   addPersonalProject:async(file,repository,label,insideRoot)=>{
    assert.equal(insideRoot,root);
    await rm(repository,{recursive:true});
    await symlink(outside,repository);
    return addPersonalProject(file,repository,label,{insideRoot});
   },
  }),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_PATH_FORBIDDEN'&&error.status===403);
 }finally{await rm(parent,{recursive:true,force:true});}
});
});
