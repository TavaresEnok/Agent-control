import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitArtifacts} from '../src/git.ts';

test('composition preserves source changes, is deterministic, and rejects scope violations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-compose-')),repo=join(root,'repo');
 try{
  execFileSync('git',['init',repo],{stdio:'ignore'});
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
  await writeFile(join(repo,'root'),'base');git('add','.');git('commit','-m','base');const base=git('rev-parse','HEAD');
  const sources=[];
  for(const path of ['one','two']){
   git('checkout','--detach',base);await writeFile(join(repo,path),path);git('add',path);git('commit','-m',path);
   sources.push({base,commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),writePaths:[path]});
  }
  const service=new GitArtifacts(repo),a=await service.compose(base,sources,join(root,'a')),b=await service.compose(base,sources,join(root,'b'));
  assert.equal(a.commit,b.commit);assert.equal(a.tree,b.tree);
  assert.equal((await service.snapshot(a.commit,base,join(root,'unreferenced-snapshot'))).tree,a.tree);
  assert.equal((await service.verifyComposition(a.snapshot,a.commit,base,sources.map(s=>s.commit))).tree,a.tree);
  await assert.rejects(service.verifyComposition(a.snapshot,a.commit,base,[sources[1]!.commit,sources[0]!.commit]));
  let launched=false;
  const supervised=await service.composeSupervised(base,sources.map(source=>({...source,sourceRepo:a.snapshot})),join(root,'supervised'),async child=>{
   await new Promise<void>((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});
   assert.ok(child.pid);launched=true;
  });
  assert.ok(launched);assert.equal(supervised.commit,a.commit);
  for(const path of ['one','two'])assert.equal(execFileSync('git',['-C',a.snapshot,'show',`${a.commit}:${path}`],{encoding:'utf8'}),path);
  await assert.rejects(service.compose(base,[{...sources[0]!,writePaths:['other']}],join(root,'bad')));
  await assert.rejects(service.compose(base,[sources[0]!,sources[0]!],join(root,'overlap')));
  assert.equal((await service.identity(a.commit,base)).tree,a.tree);
  const other=join(root,'other');execFileSync('git',['clone','--no-local',repo,other],{stdio:'ignore'});
  assert.equal((await new GitArtifacts(other).import(a.snapshot,a.commit,base)).tree,a.tree);
  assert.equal((await service.identityAt(a.snapshot,a.commit,base)).tree,a.tree);
  git('checkout','--detach',base);await symlink('root',join(repo,'link'));git('add','link');git('commit','-m','link');
  await assert.rejects(service.compose(base,[{base,commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),writePaths:['link']}],join(root,'symlink')));
  git('checkout','--detach',base);const magic=':(glob)*.txt';await writeFile(join(repo,magic),'literal');
  git('add','--',`:(literal)${magic}`);git('commit','-m','literal name');
  const literal=await service.compose(base,[{base,commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),writePaths:[magic]}],join(root,'literal'));
  assert.equal(execFileSync('git',['-C',literal.snapshot,'show',`${literal.commit}:${magic}`],{encoding:'utf8'}),'literal');
 }finally{await rm(root,{recursive:true,force:true});}
});
