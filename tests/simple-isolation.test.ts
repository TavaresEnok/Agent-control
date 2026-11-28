import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {lstat,mkdir,mkdtemp,readdir,readFile,rm,symlink,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {test} from 'node:test';
import {simpleIsolation,loadInstallation} from '../src/installation.ts';
import {discardableTempContents,oldTestVolume,removableSimpleImage,simpleJobRetention,simpleTempRetention} from '../src/personal-simple-retention.ts';
import {NativeExecutionRequest} from '../src/native-execution-shared.ts';
import {runSimpleWorker,type HostJob} from '../src/simple-execution-worker.ts';
import {linkReadonlyCheckout,pinReadonlyCheckout,releaseIdleSharedWorktrees,sharedSimpleWorktree,worktreeGit} from '../src/simple-worktree.ts';
import {isSecretClassBasename,replaceSecretClassFiles} from '../src/verify-redact.ts';
import {stripExamHostileConfig} from '../src/verify-exam-isolation.ts';
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

test('specialist bind sources share project files and keep redaction private',async()=>{
 const f=await fixture();
 try{
  await writeFile(join(f.repo,'.env'),'FIXTURE_SECRET=example');
  await writeFile(join(f.repo,'AGENTS.md'),'fixture instructions');
  await symlink('original',join(f.repo,'link'));
  await worktreeGit(f.repo,['add','.']);await worktreeGit(f.repo,['commit','-qm','exam fixture']);
  const commit=(await worktreeGit(f.repo,['rev-parse','HEAD'])).trim();
  const first=await sharedSimpleWorktree(f.data,f.repo,commit);
  const work=join(f.job,'work'),artifact=join(f.job,'review-artifact'),other=join(f.root,'second-artifact');
  try{
   const original=await lstat(join(first.path,'original'));
   assert.ok(await pinReadonlyCheckout(first.path,work));
   await first.release();
   assert.deepEqual(await readdir(work),['checkout-lease']);
   assert.deepEqual(await releaseIdleSharedWorktrees(f.data,f.repo,true),[]);
   const second=await sharedSimpleWorktree(f.data,f.repo,commit);
   try{
    assert.equal(second.path,first.path);
    for(const [source,view] of [[first.path,artifact],[second.path,other]] as const){
     await linkReadonlyCheckout(source,view,isSecretClassBasename);
     await replaceSecretClassFiles(view);
     await stripExamHostileConfig(view);
     assert.equal(await readFile(join(view,'.env'),'utf8'),'nome: .env\n');
     for(const name of ['.git','AGENTS.md','link'])assert.equal(existsSync(join(view,name)),false);
    }
    const stats=await Promise.all([first.path,artifact,other].map(path=>lstat(join(path,'original'))));
    assert.ok(stats.every(stat=>stat.ino===original.ino&&stat.dev===original.dev));
    assert.equal(await readFile(join(first.path,'.env'),'utf8'),'FIXTURE_SECRET=example');
    await second.release();assert.ok(existsSync(second.path));
    await rm(work,{recursive:true});
    assert.deepEqual(await releaseIdleSharedWorktrees(f.data,f.repo,true),['Worktree compartilhado removido '+second.path]);
    assert.equal(existsSync(second.path),false);
    assert.equal(await readFile(join(artifact,'original'),'utf8'),'base\n');
   }finally{await second.release();}
  }finally{await first.release();}
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('simple retention preserves pins, containers and recent builds, never judges by name, and selects labelled AC volumes only',()=>{
 const id='sha256:'+'a'.repeat(64),digest='sha256:'+'b'.repeat(64),now=Date.parse('2025-02-01');
 const image={Id:id,Created:'2025-01-01T00:00:00Z',RepoTags:['ac-module:stale'],RepoDigests:['repo@'+digest],Config:{}};
 assert.ok(removableSimpleImage(image,new Set(),new Set(),now));
 for(const pin of [digest,id])assert.ok(!removableSimpleImage(image,new Set([pin]),new Set(),now));
 assert.ok(!removableSimpleImage(image,new Set(),new Set([id]),now));
 // Built less than 24 h ago (or with no creation time): a candidate may still be on its way to a pin.
 assert.ok(!removableSimpleImage({...image,Created:'2025-01-31T12:00:00Z'},new Set(),new Set(),now));
 assert.ok(!removableSimpleImage({...image,Created:undefined},new Set(),new Set(),now));
 // A name such as "design" protects nothing any more: only a pin or use does.
 assert.ok(removableSimpleImage({...image,RepoTags:['ac-design:old']},new Set(),new Set(),now));
 assert.ok(!removableSimpleImage({...image,RepoTags:['ajust-erp/web:old'],RepoDigests:[]},new Set(),new Set(),now));
 const volume={Name:'ac-implementation_sandbox-pg',CreatedAt:'2025-01-01',Labels:{'com.docker.compose.project':'ac-implementation','com.docker.compose.volume':'sandbox-pg'}};
 assert.ok(oldTestVolume(volume,Date.parse('2025-02-01')));
 assert.ok(!oldTestVolume(volume,Date.parse('2025-01-01')));
 assert.ok(oldTestVolume({Name:'0123abcd',CreatedAt:'2025-01-01',Labels:{'com.agent-control.installation':'x'}},now));
 for(const Name of ['anonymous','ac-test-db-journal'])assert.ok(!oldTestVolume({...volume,Labels:null,Name},now));
});

for(const launcher of ['systemd','child','refused'])test('the personal module CLI records the launch and terminal outcome for '+launcher, {skip:!process.env.AC_TEST_DATABASE_URL}, async()=>{
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
  const ack=join(f.root,'launch-observation');
  const runUnit=launcher==='child'?'#!/bin/sh\nexit 1\n':`#!${process.execPath}
const fs=require('node:fs'), {spawnSync}=require('node:child_process');
const {Client}=require(${JSON.stringify(fileURLToPath(import.meta.resolve('pg')))});
const [command,...args]=process.argv.slice(process.argv.indexOf('--')+1);
if(command==='/bin/true')process.exit(0);
(async()=>{
 const db=new Client({connectionString:${JSON.stringify(database.url)}});await db.connect();
 const {input}=JSON.parse(fs.readFileSync(args.at(-1)));
 const {rows}=await db.query('SELECT j.state,g.state AS grant FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE j.id=$1',[input.jobId]);
 await db.end();fs.writeFileSync(${JSON.stringify(ack)},JSON.stringify(rows[0]));
 process.exitCode=${launcher==='refused'?'1':"spawnSync(command,args,{stdio:'inherit'}).status??1"};
})().catch(()=>process.exit(2));`;
  await writeFile(join(bin,'systemd-run'),runUnit,{mode:0o755});
  await writeFile(join(bin,'systemctl'),launcher==='child'?'#!/bin/sh\nexit 1\n':'#!/bin/sh\necho inactive\n',{mode:0o755});
  await writeFile(join(bin,'codex'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  await writeFile(join(bin,'claude'),`#!${process.execPath}
const fs=require('node:fs');
if(!fs.existsSync(process.env.HOME+'/.credentials.json')||process.env.HOME!==process.env.CLAUDE_CONFIG_DIR)process.exit(2);
try{fs.appendFileSync('index.ts','attempt');process.exit(3);}catch(error){if(error.code!=='EACCES'&&error.code!=='EPERM')throw error;}
fs.writeFileSync(process.env.TMPDIR+'/scratch','ok');
const task=JSON.parse(fs.readFileSync(0,'utf8').split('\\nReturn JSON matching ')[0]);
console.log(JSON.stringify({structured_output:{kind:'exame',binding:task.binding,filesRead:[task.file],checklist:['qa'],routesReviewed:[],findings:[]}}));
`,{mode:0o755});
  process.env.PATH=bin+':'+oldPath;
  const execution=runPersonalModuleCli('qa',[install,project],{moduleExamRuntime:async()=>exam!.runtime.slice(0,1),collectorOutput:{coverage:[{tool:'qa-auditoria-estatica-testes',version:'1',status:'ok',detail:'leitura local'}],findings:[]}});
  if(launcher==='refused')await execution.catch(()=>undefined);else await execution;
  if(launcher!=='child')assert.deepEqual(JSON.parse(await readFile(ack,'utf8')),{state:'uncertain',grant:'uncertain'});
  const jobs=await ledger.pool.query('SELECT j.id,j.state,j.receipt,j.worker_id,g.state AS grant,g.physical_receipt FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id');
  assert.ok(jobs.rowCount);
  for(const job of jobs.rows){
   assert.equal(job.state,launcher==='refused'?'failed':'completed',JSON.stringify(job.receipt));
   assert.equal(job.grant,'released');
   if(launcher==='child')assert.equal(job.physical_receipt.launcher,'child');
   else assert.match(job.physical_receipt.unit,/^ac-simple-/);
   assert.equal(job.worker_id,null);
   assert.equal(job.receipt.payload.isolation,'simple');
  }
  if(launcher==='refused')return;
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

test('old clean clones whose commits are all on a project branch are removed; dirty, recent and unpublished ones stay',async()=>{
 const f=await fixture(),previousTmp=process.env.TMPDIR,previousPath=process.env.PATH;
 try{
  const temporary=join(f.root,'temporary'),bin=join(f.root,'bin');
  await mkdir(temporary);await mkdir(bin);
  await writeFile(join(bin,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  process.env.TMPDIR=temporary;process.env.PATH=bin+':'+previousPath;
  await writeFile(join(f.repo,'migration.sql'),'SELECT 1;');
  await worktreeGit(f.repo,['add','.']);await worktreeGit(f.repo,['commit','-qm','migration']);
  const clones=['ac-review-clean','ac-review-dirty','ac-worker-copy','ac-review-recent','ac-review-unpublished'];
  for(const name of clones){
   const path=join(temporary,name);
   await worktreeGit(f.repo,['clone','--quiet','--no-local',f.repo,path]);
   if(name.endsWith('dirty'))await writeFile(join(path,'original'),'unpublished');
   if(name.endsWith('unpublished')){
    await worktreeGit(path,['commit','--allow-empty','-qm','unpublished review']);
   }
   if(!name.endsWith('recent')){
    const old=new Date(Date.now()-2*86400000);
    for(const rel of await readdir(path,{recursive:true}))await utimes(join(path,rel),old,old);
    await utimes(path,old,old);
   }
  }
  const config={dataDirectory:f.data,project:{id:randomUUID(),repo:f.repo,owner:'fixture',label:'test'},projects:[]};
  assert.deepEqual(await simpleTempRetention(config,false),['Temporário elegível ac-review-clean','Temporário elegível ac-worker-copy']);
  assert.deepEqual(await simpleTempRetention(config,true),['Temporário removido ac-review-clean','Temporário removido ac-worker-copy']);
  assert.deepEqual((await readdir(temporary)).sort(),['ac-review-dirty','ac-review-recent','ac-review-unpublished']);
 }finally{
  if(previousTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp;
  process.env.PATH=previousPath;await rm(f.root,{recursive:true,force:true});
 }
});
