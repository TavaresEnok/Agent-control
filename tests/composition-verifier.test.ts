import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('composition verifier reconstructs the frozen sources and rejects a mismatched tree',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ac-composition-verifier-'));
 const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',env:{...process.env,GIT_LITERAL_PATHSPECS:'1'}}).trim();
 try{
  git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(dir,'base'),'base\n');git('add','base');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  const sources=[];
  for(const [i,path] of ['first.txt',':magic.txt'].entries()){
   git('checkout','-q','--detach',base);writeFileSync(join(dir,path),`${i}\n`);git('add',path);git('commit','-qm',path);
   const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');git('update-ref',`refs/agent-control/sources/${i}`,commit);
   sources.push({unitId:`unit-${i}`,artifactId:'12345678-1234-4234-8234-123456789abc',commit,tree,base,writePaths:[path]});
  }
  git('checkout','-q','--detach',base);let tree=git('rev-parse',`${base}^{tree}`);
  for(const source of sources){git('read-tree','-m',base,tree,source.commit);tree=git('write-tree');}
  const candidate=git('commit-tree',tree,'-p',base,'-m','composition');git('checkout','-q','--detach',candidate);
  const run=(value:unknown)=>spawnSync(process.execPath,[resolve('scripts/synthetic-verifier.mjs'),dir,'12345678-1234-1234-1234-123456789abc','qa','--composition',Buffer.from(JSON.stringify(value)).toString('base64')],{encoding:'utf8'});
  assert.equal(run(sources).status,0);
  assert.notEqual(run([{...sources[0],tree:'0'.repeat(40)},sources[1]]).status,0);
  assert.notEqual(run([{...sources[0],writePaths:['outside.txt']},sources[1]]).status,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
