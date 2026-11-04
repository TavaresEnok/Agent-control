import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitArtifacts} from '../src/git.ts';

test('Git CAS blocks competing candidates and a target moved by an outside writer',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-cas-concurrent-')),repo=join(root,'repo');
 try{
  execFileSync('git',['init','-q','-b','main',repo]);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
  await writeFile(join(repo,'base'),'base');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  const commits:string[]=[];
  for(const name of ['a','b','external']){
   git('checkout','--detach',base);await writeFile(join(repo,name),name);git('add',name);git('commit','-qm',name);commits.push(git('rev-parse','HEAD'));
  }
  const [a,b,external]=commits as [string,string,string];
  git('update-ref','refs/heads/protected',base);
  const service=new GitArtifacts(repo),target='refs/heads/protected';
  const results=await Promise.allSettled([service.cas(a,base,target,randomUUID()),service.cas(b,base,target,randomUUID())]);
  const integrated=results.filter(result=>result.status==='fulfilled'&&result.value.status==='integrated');
  assert.equal(integrated.length,1);
  const winner=git('rev-parse',target);assert([a,b].includes(winner));
  const losing=results.find(result=>result.status==='rejected'||result.value.status==='rejected');assert(losing);
  if(losing.status==='fulfilled')assert.deepEqual(losing.value,{status:'rejected',reason:'BASE_MOVED'});
  else assert.match(String(losing.reason),/GIT_IDENTITY_REFUSED/);
  git('update-ref',target,external,winner);
  const stale=await service.cas(a,base,target,randomUUID());
  assert.deepEqual(stale,{status:'rejected',reason:'BASE_MOVED'});
  assert.equal(git('rev-parse',target),external);
 }finally{await rm(root,{recursive:true,force:true});}
});
