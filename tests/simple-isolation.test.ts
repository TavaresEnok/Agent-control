import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {lstat,mkdir,mkdtemp,readFile,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {simpleIsolation,loadInstallation} from '../src/installation.ts';
import {discardableTempContents,oldTestVolume,removableSimpleImage,simpleJobRetention} from '../src/personal-simple-retention.ts';
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

test('the personal module CLI runs the provider in its account HOME and records a terminal host job', {skip:!process.env.AC_TEST_DATABASE_URL}, async()=>{
 const {Ledger}=await import('../src/ledger.ts');
 const {Capacity}=await import('../src/capacity.ts');
 const {isolatedDatabase}=await import('./fixtures/isolated-database.ts');
 const {createModuleExamFixture}=await import('./fixtures/module-exam-native.ts');
 const {runPersonalModuleCli}=await import('../src/personal-module-cli.ts');
 const database=await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!,'simplehost');
 const ledger=new Ledger(database.url),f=await fixture(),owner='simple-test',project=randomUUID(),bin=join(f.root,'bin');
 const oldPath=process.env.PATH;
 let exam:Awaited<ReturnType<typeof createModuleExamFixture>>|undefined;
 try{
  await ledger.migrate();
  await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Simple']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,owner]);
  await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,f.repo]);
  await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[owner]);
  await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const context=await ledger.createContext(owner,project,randomUUID());
  const capacity=new Capacity(ledger);
  await capacity.configure(owner,{programmingLimit:2,evaluationLimit:2});
  exam=await createModuleExamFixture({root:f.root,repo:f.repo,ledger,owner,project,simple:true});
  const rev=await capacity.publish(owner,project,0,{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{specialist:{regular:exam.profiles,emergency:[]}}});
  await capacity.assignPolicy(owner,context,rev);
  const install=join(f.data,'installation.json');
  await writeFile(install,JSON.stringify({schemaVersion:1,mode:'administration-only',activation:'personal',dataDirectory:f.data,databaseUrl:database.url,
   project:{id:project,repo:f.repo,owner,label:'simple',economy:{batch:false}},http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'}}),{mode:0o600});
  await worktreeGit(f.repo,['mv','original','index.ts']);
  await worktreeGit(f.repo,['commit','-qm','include source']);
  await mkdir(bin);
  // The fixture executes the exact worker argv. Systemd and inference cost no
  // host resources outside the temporary fixture or its isolated database.
  await writeFile(join(bin,'systemd-run'),'#!/bin/sh\nwhile [ "$1" != -- ]; do shift || exit 1; done\nshift\nexec "$@"\n',{mode:0o755});
  await writeFile(join(bin,'systemctl'),'#!/bin/sh\necho inactive\n',{mode:0o755});
  await writeFile(join(bin,'codex'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  await writeFile(join(bin,'claude'),`#!${process.execPath}
const fs=require('node:fs');
if(!fs.existsSync(process.env.HOME+'/.credentials.json')||process.env.HOME!==process.env.CLAUDE_CONFIG_DIR)process.exit(2);
const task=JSON.parse(fs.readFileSync(0,'utf8').split('\\nReturn JSON matching ')[0]);
console.log(JSON.stringify({structured_output:{kind:'exame',binding:task.binding,filesRead:[task.file],checklist:['qa'],routesReviewed:[],findings:[]}}));
`,{mode:0o755});
  process.env.PATH=bin+':'+oldPath;
  await runPersonalModuleCli('qa',[install,project],{moduleExamRuntime:async()=>exam!.runtime.slice(0,1),collectorOutput:{coverage:[{tool:'qa-auditoria-estatica-testes',version:'1',status:'ok',detail:'leitura local'}],findings:[]}});
  const jobs=await ledger.pool.query('SELECT id,state,receipt,worker_id FROM ac_native_execution_jobs');
  assert.ok(jobs.rowCount);
  for(const job of jobs.rows){
   assert.equal(job.state,'completed',JSON.stringify(job.receipt));
   assert.equal(job.worker_id,null);
   assert.equal(job.receipt.payload.isolation,'simple');
  }
  const hostRoot=join(f.root,'fixture-spool'),root=join(hostRoot,jobs.rows[0].id);
  const oldWork=join(root,'work'),mountedReview=join(root,'review-artifact'),unknown=join(hostRoot,randomUUID(),'work');
  await mkdir(oldWork);await mkdir(mountedReview);await mkdir(unknown,{recursive:true,mode:0o700});
  await writeFile(join(oldWork,'data'),'terminal copy');
  const config={...await loadInstallation(install),nativeBootstrap:{state:'active' as const,execution:{hostRoot}}};
  const mounts=async()=>[mountedReview];
  assert.ok((await simpleJobRetention(config,false,mounts)).some(line=>line.endsWith(oldWork)));
  assert.ok(existsSync(oldWork));
  await simpleJobRetention(config,true,mounts);
  assert.ok(!existsSync(oldWork)&&existsSync(mountedReview)&&existsSync(unknown));
  await simpleJobRetention(config,true,async()=>[]);
  assert.ok(!existsSync(mountedReview)&&existsSync(join(root,'output','execution-result.json'))&&existsSync(join(root,'worker-terminal.log')));
  assert.equal(exam.docker.observations.length,0);
  assert.equal((await worktreeGit(f.repo,['worktree','list','--porcelain'])).match(/^worktree /gm)?.length,1);
 }finally{
  process.env.PATH=oldPath;
  await exam?.docker.close();await ledger.close();await database.close();await rm(f.root,{recursive:true,force:true});
 }
});

test('retention keeps data and active files nested in an old temporary directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-simple-temp-test-')),path=join(root,'nested');
 try{
  const device=(await lstat(root,{bigint:true})).dev;
  await mkdir(path);
  for(const name of ['verificacoes','pre-backup','PG_VERSION','.git']){
   await writeFile(join(path,name),'protected');
   assert.equal(await discardableTempContents(root,device,Date.now()+1000),false);
   await rm(join(path,name));
  }
  const ordinary=join(path,'report.log');await writeFile(ordinary,'old');
  await utimes(path,new Date(0),new Date(0));
  assert.equal(await discardableTempContents(root,device,Date.now()-86400000),false);
  await utimes(ordinary,new Date(0),new Date(0));
  assert.equal(await discardableTempContents(root,device,Date.now()-86400000),true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('native collector arguments mount the examined commit and databases read-only in an offline namespace',async()=>{
 const {hostCollectorArgs}=await import('../src/simple-host-tools.ts');
 const args=hostCollectorArgs({module:'verify',command:['/usr/local/bin/verify-entrypoint.sh'],identity:'host-verify'},
  '/private/checkout',{databases:'/private/db',output:'/private/results'});
 assert.ok(args.includes('--unshare-all'));
 for(const [path,destination] of [['/private/checkout','/repository'],['/private/db','/databases']]){
  const at=args.indexOf(path!);
  assert.equal(args[at-1],'--ro-bind');
  assert.equal(args[at+1],destination);
 }
 assert.equal(args[args.indexOf('/private/results')-1],'--bind');
 assert.ok(!args.includes('/home')&&!args.includes('/run/docker.sock'));
});
