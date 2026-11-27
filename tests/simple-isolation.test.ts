import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {lstat,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {simpleIsolation} from '../src/installation.ts';
import {oldTestVolume,removableSimpleImage} from '../src/personal-simple-retention.ts';
import {NativeExecutionRequest} from '../src/native-execution-shared.ts';
import {runSimpleWorker,type HostJob} from '../src/simple-execution-worker.ts';
import {sharedSimpleWorktree,worktreeGit} from '../src/simple-worktree.ts';
import {verifyExamArguments} from '../src/verify-image.ts';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'ac-simple-test-')),repo=join(root,'repo'),data=join(root,'data'),home=join(data,'accounts',randomUUID()),job=join(data,'native',randomUUID());
 await mkdir(repo);await mkdir(home,{recursive:true});await mkdir(join(job,'output'),{recursive:true});
 await writeFile(join(home,'.credentials.json'),JSON.stringify({access_token:'fixture-account-private-value'}),{mode:0o600});
 await worktreeGit(repo,['init','-q']);
 await writeFile(join(repo,'original'),'base\n');
 await worktreeGit(repo,['add','.']);await worktreeGit(repo,['commit','-qm','base']);
 const commit=(await worktreeGit(repo,['rev-parse','HEAD'])).trim();
 const input=NativeExecutionRequest.parse({jobId:randomUUID(),intentId:randomUUID(),grantId:randomUUID(),sessionId:randomUUID(),role:'programmer',base:commit,writePaths:['original'],task:'alterar original'});
 const spec:HostJob={input,repo,home,dataDirectory:data,provider:'claude',model:'claude-opus-5-5',effort:'medium'};
 return {root,repo,data,job,commit,spec};
}

test('personal defaults to simple and locked installations keep the strict path',()=>{
 assert.ok(simpleIsolation({activation:'personal'}));
 assert.ok(!simpleIsolation({activation:'personal',isolation:'strict'}));
 assert.ok(!simpleIsolation({activation:'locked',isolation:'simple'}));
});

test('writers publish the candidate in the original object database then release their worktree',async()=>{
 const f=await fixture();
 try{
  await runSimpleWorker(f.job,f.spec,async(job,cwd)=>{
   assert.equal(job.home,f.spec.home);
   assert.ok((await lstat(join(cwd,'.git'))).isFile());
   await writeFile(join(cwd,'original'),'changed\n');
   return {output:'feito',usageCounters:null,normalizedTokensUsed:null};
  });
  const result=JSON.parse(await readFile(join(f.job,'output','execution-result.json'),'utf8'));
  assert.equal(result.failureCode,null);
  const artifact=JSON.parse(await readFile(join(f.job,'output','artifact.json'),'utf8'));
  assert.equal((await worktreeGit(f.repo,['show',artifact.commit+':original'])).trim(),'changed');
  assert.equal((await readFile(join(f.repo,'original'),'utf8')).trim(),'base');
  assert.ok(!existsSync(join(f.job,'work')));
  assert.equal((await worktreeGit(f.repo,['worktree','list','--porcelain'])).match(/^worktree /gm)?.length,1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('failed or canceled jobs release the checkout and keep their result',async()=>{
 const f=await fixture();
 try{
  await runSimpleWorker(f.job,f.spec,async()=>{throw new Error('canceled');});
  assert.ok(!existsSync(join(f.job,'work')));
  assert.equal(JSON.parse(await readFile(join(f.job,'output','execution-result.json'),'utf8')).exitCode,1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('concurrent exams and reviewers share a detached commit until its last reader exits',async()=>{
 const f=await fixture();
 try{
  const [a,b]=await Promise.all([sharedSimpleWorktree(f.data,f.repo,f.commit),sharedSimpleWorktree(f.data,f.repo,f.commit,true)]);
  assert.equal(a.path,b.path);
  assert.ok((await lstat(join(a.path,'.git'))).isFile());
  await a.release();assert.ok(existsSync(b.path));
  const args=verifyExamArguments({image:'sha256:'+'a'.repeat(64),repository:b.path,output:'/output',databases:'/db',memoryBytes:1024,nanoCpus:1,pidsLimit:1,commonTools:true});
  assert.ok(args.includes('type=bind,src='+b.path+',dst=/repository,readonly'));
  assert.deepEqual(args.slice(-3),['/usr/local/bin/ac-collect','sha256:'+'a'.repeat(64),'verify']);
  await b.release();assert.ok(!existsSync(b.path));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('simple retention preserves pins, containers, design and homologation, and selects old test databases only',()=>{
 const id='sha256:'+'a'.repeat(64),digest='sha256:'+'b'.repeat(64);
 const image={Id:id,RepoTags:['ac-module:stale'],RepoDigests:['repo@'+digest],Config:{}};
 assert.ok(removableSimpleImage(image,new Set(),new Set()));
 for(const pin of [digest,id])assert.ok(!removableSimpleImage(image,new Set([pin]),new Set()));
 assert.ok(!removableSimpleImage(image,new Set(),new Set([id])));
 for(const tag of ['ac-chatisp-homolog-1:old','chatisp:homolog-antes-abcd','ac-design:old','agent-control-exam-tools:simple'])
  assert.ok(!removableSimpleImage({...image,RepoTags:[tag,...image.RepoTags]},new Set(),new Set()));
 const volume={Name:'ac-implementation_sandbox-pg',CreatedAt:'2025-01-01',Labels:{'com.docker.compose.project':'ac-implementation','com.docker.compose.volume':'sandbox-pg'}};
 assert.ok(oldTestVolume(volume,Date.parse('2025-02-01')));
 assert.ok(!oldTestVolume(volume,Date.parse('2025-01-01')));
 for(const Name of ['ac-test-db-journal','ac-chatisp-homolog-postgres'])assert.ok(!oldTestVolume({...volume,Name},Date.now()));
 assert.ok(!oldTestVolume({...volume,Labels:null,Name:'anonymous'},Date.now()));
});
