import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonalProject} from '../src/personal-panel-projects.ts';

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
