import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {mkdtemp,readFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Installation} from '../src/installation.ts';
import {simpleDockerRetention,simpleJobDirectoryRetention} from '../src/personal-simple-retention.ts';
import {simpleTempRetention} from '../src/temp-retention.ts';
import {devWorktreeRetention} from '../src/dev-worktree-retention.ts';
import {RetentionIncomplete,readRetentionReport,retentionSummary,runRetentionStages} from '../src/personal-maintenance.ts';
import {Refusal} from '../src/contracts.ts';

const HOUR=3600_000,DAY=24*HOUR;
const sha=(c:string)=>'sha256:'+c.repeat(64);
const gitEnv={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',
 GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid'};
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env:gitEnv,encoding:'utf8'}).trim();
const rootOnly=async()=>'22 1 8:1 / / rw - ext4 /dev/sda1 rw\n';
const iso=(ms:number)=>new Date(ms).toISOString();
async function age(path:string,ms:number){
 const when=new Date(Date.now()-ms);
 for(const entry of readdirSync(path,{recursive:true}) as string[])await utimes(join(path,entry),when,when).catch(()=>undefined/* dangling link */);
 await utimes(path,when,when);
}
async function base(){return realpathSync(await mkdtemp(join(tmpdir(),'retention-maturity-')));}

// ---- Docker ------------------------------------------------------------------------------------------------------

type FakeContainer={Id:string;Name:string;Image:string;Created:string;State:{Status:string;Running:boolean;FinishedAt?:string};Config:{Labels:Record<string,string>|null};Mounts:{Source:string}[]};
type FakeImage={Id:string;Created:string;RepoTags:string[];RepoDigests:string[];Config:{Entrypoint:null}};
function fakeDocker(state:{containers:FakeContainer[];images:FakeImage[];volumes:{Name:string;CreatedAt:string;Labels:Record<string,string>|null}[]}){
 const calls:string[][]=[];
 const fail=(message:string)=>Object.assign(new Error(message),{stderr:message});
 const docker=async(args:string[])=>{
  calls.push(args);
  const [a,b]=args;
  if(a==='info')return 'daemon-test';
  if(a==='container'&&b==='ls')return state.containers.map(c=>c.Id).join('\n');
  if(a==='container'&&b==='inspect')return JSON.stringify(args.slice(2).map(id=>state.containers.find(c=>c.Id===id)).filter(Boolean));
  if(a==='container'&&b==='rm'){state.containers=state.containers.filter(c=>c.Id!==args[2]);return '';}
  if(a==='image'&&b==='ls')return state.images.map(i=>i.Id).join('\n');
  if(a==='image'&&b==='inspect'&&args[2]==='--format'){
   const found=state.images.find(i=>i.RepoTags.includes(args[4]!)||i.Id===args[4]);
   if(!found)throw fail('Error response from daemon: No such image: '+args[4]);
   return found.Id;
  }
  if(a==='image'&&b==='inspect')return JSON.stringify(args.slice(2).map(id=>state.images.find(i=>i.Id===id)).filter(Boolean));
  if(a==='image'&&b==='rm'){state.images=state.images.filter(i=>i.Id!==args[2]);return '';}
  if(a==='volume'&&b==='ls')return state.volumes.map(v=>v.Name).join('\n');
  if(a==='volume'&&b==='inspect')return JSON.stringify(state.volumes.filter(v=>v.Name===args[2]));
  if(a==='volume'&&b==='rm'){state.volumes=state.volumes.filter(v=>v.Name!==args[2]);return '';}
  throw fail('unexpected docker '+args.join(' '));
 };
 return {calls,docker};
}

test('Docker retention: stopped AC containers, unpinned AC images and labelled orphan volumes leave; pins, use, configuration and unlabelled volumes stay; no builder prune',async()=>{
 const root=await base();
 try{
  const now=Date.now(),old=iso(now-3*DAY),recent=iso(now-HOUR);
  const data=join(root,'data'),product=join(root,'product');
  mkdirSync(data,{mode:0o700});mkdirSync(join(product,'deploy','modules','qa'),{recursive:true});
  writeFileSync(join(product,'deploy','modules','qa','digest.txt'),sha('b')+'\n');
  writeFileSync(join(product,'deploy','design-image-digest.txt'),'localhost:5000/ac-design:fixada@'+sha('9')+'\n');
  const ended=randomUUID(),running=randomUUID();
  const img=(c:string,tags:string[],digests:string[]=[],created=old):FakeImage=>({Id:sha(c),Created:created,RepoTags:tags,RepoDigests:digests,Config:{Entrypoint:null}});
  const box=(id:string,name:string,image:string,status:'exited'|'running',finished:string,labels:Record<string,string>|null=null):FakeContainer=>
   ({Id:id,Name:'/'+name,Image:image,Created:old,State:{Status:status,Running:status==='running',FinishedAt:finished},Config:{Labels:labels},Mounts:[]});
  const state={
   containers:[
    box('c1','ac-native-worker-'+ended,sha('5'),'exited',old,{'agent-control.job':ended}),
    box('c2','ac-native-tools-'+running,sha('e'),'exited',old,{'agent-control.job':running}),
    box('c3','ac-perf-a678dacc',sha('6'),'exited',old),
    box('c4','ac-perf-recente',sha('7'),'exited',recent),
    box('c5','ajust_test_db',sha('8'),'exited',old),
    box('c6','ac-personal-pg',sha('8'),'exited',old,{'com.agent-control.installation':'x'}),
    box('c7','ac-test-db-journal',sha('8'),'running','0001-01-01T00:00:00Z'),
   ],
   images:[
    img('a',['ac-module-qa:velha']),
    img('b',['ac-aceite-retomada/qa:fixada']),
    img('c',['ac-native-execution:antes-opus-high-cccc']),
    img('d',['ac-design:reconstrucao']),
    img('9',['localhost:5000/ac-design:fixada'],['localhost:5000/ac-design@'+sha('9')]),
    img('e',['ac-native-tools:em-uso']),
    img('f',['agent-control-exam-tools:simple']),
    img('1',['ajust-erp/web:antiga']),
    img('2',['ac-module-qa:recente'],[],recent),
    img('5',['ac-native-execution:job-terminal']),
   ],
   volumes:[
    {Name:'ac-orfao-rotulado',CreatedAt:old,Labels:{'com.agent-control.project':'p'}},
    {Name:'0f00anonimo',CreatedAt:old,Labels:null},
    {Name:'ac-rotulado-recente',CreatedAt:recent,Labels:{'com.agent-control.project':'p'}},
   ],
  };
  const fake=fakeDocker(state);
  // Image c is referenced only by the native bootstrap (a retired executor pair).
  const config={activation:'personal',dataDirectory:data,databaseUrl:'postgres://invalid.example/none',project:{id:randomUUID(),label:'p',repo:join(root,'repo'),owner:'o'},projects:[],
   dockerDependencies:{containers:['ac-personal-pg'],autoStart:false},
   nativeBootstrap:{state:'active',planning:{imageId:sha('3')},execution:{workerImage:sha('4'),toolsImage:sha('4'),retiredImages:[{workerImage:sha('c'),toolsImage:sha('4')}]}}} as unknown as Installation;
  const deps={docker:fake.docker,now:()=>now,terminalJobs:async(_c:Installation,ids:string[])=>new Set(ids.filter(id=>id===ended)),
   retention:{productRoot:product,sharedRefsRoot:join(root,'refs'),verifyRunImages:async()=>[]}};
  const preview=await simpleDockerRetention(config,false,deps);
  assert.ok(preview.includes('Contêiner parado elegível ac-native-worker-'+ended));
  assert.ok(preview.includes('Contêiner parado preservado (job ainda não terminal no banco) ac-native-tools-'+running));
  assert.equal(state.containers.length,7,'a preview removes nothing');
  const applied=await simpleDockerRetention(config,true,deps);
  assert.deepEqual(state.containers.map(c=>c.Name.slice(1)).sort(),['ac-native-tools-'+running,'ac-perf-recente','ac-personal-pg','ac-test-db-journal','ajust_test_db'].sort());
  // a (unpinned), d ("design" in the name protects nothing) and 5 (its only container left) go.
  assert.deepEqual(state.images.map(i=>i.Id).sort(),[sha('b'),sha('c'),sha('9'),sha('e'),sha('f'),sha('1'),sha('2')].sort());
  assert.deepEqual(state.volumes.map(v=>v.Name).sort(),['0f00anonimo','ac-rotulado-recente']);
  assert.ok(applied.includes('Volume removido ac-orfao-rotulado'));
  assert.equal(fake.calls.some(args=>args.includes('builder')||args.includes('prune')||args.includes('system')),false,'never a prune on the shared daemon');
  assert.equal(fake.calls.some(args=>args.includes('-f')||args.includes('--force')||args.includes('--volumes')||args.includes('-v')),false,'never forced');
  assert.match(applied.at(-1)!,/Cache de build: o do daemon compartilhado não é tocado/);
 }finally{await rm(root,{recursive:true,force:true});}
});

// ---- Job directories -----------------------------------------------------------------------------------------------

test('a terminal job directory older than jobDirRetentionDays leaves; recent, non-terminal, busy and unfinished ones stay; the database is only read',async()=>{
 const root=await base();
 try{
  const host=join(root,'execution-host');mkdirSync(host,{mode:0o700});
  const make=(name:string,options:{work?:boolean}={})=>{
   const path=join(host,name);mkdirSync(join(path,'output'),{recursive:true,mode:0o700});
   writeFileSync(join(path,'output','execution-result.json'),'{}');writeFileSync(join(path,'request.json'),'{}');
   if(options.work)mkdirSync(join(path,'work'));
   return path;
  };
  const ids={old:randomUUID(),recent:randomUUID(),open:randomUUID(),work:randomUUID(),container:randomUUID(),held:randomUUID(),unknown:randomUUID()};
  const paths=Object.fromEntries(Object.entries(ids).map(([key,id])=>[key,make(id,{work:key==='work'})])) as Record<keyof typeof ids,string>;
  for(const [key,path] of Object.entries(paths))if(key!=='recent')await age(path,10*DAY);
  // An interrupted earlier removal is finished.
  const condemned=join(host,'.removendo-'+randomUUID());mkdirSync(join(condemned,'planning'),{recursive:true});writeFileSync(join(condemned,'planning','x.png'),'x');
  const terminal=new Set<string>([ids.old,ids.recent,ids.work,ids.container,ids.held]);
  const reads:string[][]=[];
  const fake=fakeDocker({containers:[{Id:'k',Name:'/ac-native-tools-'+ids.container,Image:sha('1'),Created:iso(0),State:{Status:'exited',Running:false},Config:{Labels:null},Mounts:[]}],images:[],volumes:[]});
  const config={databaseUrl:'postgres://invalid.example/none',dataDirectory:root,project:{id:randomUUID(),label:'p',repo:root,owner:'o'},projects:[],
   nativeBootstrap:{state:'active' as const,execution:{hostRoot:host}},storage:{jobDirRetentionDays:7}} as never;
  const deps={docker:fake.docker,mountInfo:rootOnly,openPaths:async()=>[join(paths.held,'worker-terminal.log')],
   terminalJobs:async(_c:unknown,candidates:string[],each:(id:string)=>Promise<void>)=>{reads.push([...candidates].sort());for(const id of candidates)if(terminal.has(id))await each(id);}};
  const preview=await simpleJobDirectoryRetention(config,false,deps);
  assert.match(preview.join('\n'),/Pastas de job terminais com mais de 7 dia\(s\): 1 elegível\(is\)\. O recibo fica no banco\./);
  assert.ok(existsSync(paths.old)&&existsSync(condemned));
  await simpleJobDirectoryRetention(config,true,deps);
  assert.equal(existsSync(paths.old),false);
  assert.equal(existsSync(condemned),false);
  for(const key of ['recent','open','work','container','held','unknown'] as const)assert.ok(existsSync(join(paths[key],'output','execution-result.json')),key+' stays');
  // Only the old candidates reach the database, and only to be read.
  assert.deepEqual(reads.at(-1),[ids.old,ids.open,ids.unknown].sort());
 }finally{await rm(root,{recursive:true,force:true});}
});

// ---- Temporaries ---------------------------------------------------------------------------------------------------

test('old temporaries leave with their clean checkout (tracked .sql included); one in use, one with an orphan commit and a recent one stay',async()=>{
 const root=await base();
 try{
  const repo=join(root,'repo'),tmp=join(root,'tmp');mkdirSync(repo);mkdirSync(tmp,{mode:0o700});
  git(repo,'init','-q','-b','main');writeFileSync(join(repo,'001_migration.sql'),'SELECT 1;\n');git(repo,'add','.');git(repo,'commit','-qm','first');
  // A worktree of the project nested in a temporary, on a branch: it leaves through git and its branch stays.
  const proof=join(tmp,'ac-update-proof.AAAA');mkdirSync(proof);writeFileSync(join(proof,'report.log'),'ok');
  git(repo,'worktree','add','-q','-b','task/proof',join(proof,'checkout'),'main');
  // A standalone clone with a commit that no branch of the project has.
  const orphan=join(tmp,'ac-review-orphan');git(root,'clone','-q','--no-local',repo,orphan);git(orphan,'commit','-q','--allow-empty','-m','only here');
  const busy=join(tmp,'ac-busy');mkdirSync(busy);writeFileSync(join(busy,'log'),'x');
  const recent=join(tmp,'ac-recent');mkdirSync(recent);writeFileSync(join(recent,'log'),'x');
  for(const path of [proof,orphan,busy])await age(path,3*DAY);
  const config={dataDirectory:join(root,'data'),project:{id:randomUUID(),repo,owner:'o',label:'p'},projects:[]};
  const deps={tmpRoot:tmp,mountInfo:rootOnly,containerMounts:async()=>[],processInside:async(path:string)=>path===busy};
  assert.deepEqual(await simpleTempRetention(config,false,deps),['Temporário elegível ac-update-proof.AAAA']);
  assert.deepEqual(await simpleTempRetention(config,true,deps),['Temporário removido ac-update-proof.AAAA']);
  assert.equal(existsSync(proof),false);
  assert.ok(existsSync(orphan)&&existsSync(busy)&&existsSync(recent));
  assert.equal(git(repo,'rev-parse','--verify','refs/heads/task/proof').length,40);
  assert.doesNotMatch(git(repo,'worktree','list'),/ac-update-proof/);
 }finally{await rm(root,{recursive:true,force:true});}
});

// ---- Development worktrees of the product ------------------------------------------------------------------------

test('product worktrees: integrated, clean and idle leave with their branch; unmerged tip, orphan commit, tracked change, stray file, busy or recent stay; prune only drops entries without a directory',async()=>{
 const root=await base();
 try{
  const repo=join(root,'agent-control'),wt=join(root,'ac-wt');mkdirSync(repo);mkdirSync(wt);
  git(repo,'init','-q','-b','master');writeFileSync(join(repo,'a.txt'),'a\n');git(repo,'add','.');git(repo,'commit','-qm','first');
  const add=(name:string,commit=true)=>{
   const path=join(wt,name);git(repo,'worktree','add','-q','-b','task/'+name,path,'master');
   if(commit){writeFileSync(join(path,name+'.txt'),name);git(path,'add','.');git(path,'commit','-qm',name);}
   return path;
  };
  const integrated=add('integrado'),unmerged=add('nao-integrado'),changed=add('mudanca',false),stray=add('relatorio',false),built=add('build',false),busy=add('ocupado',false),recent=add('recente',false);
  git(repo,'merge','-q','--ff-only','task/integrado');
  // A fresh worktree with no commit of its own sits on the base tip: integrated too.
  const fresh=add('sem-commit',false);
  const orphan=add('orfao',false);git(orphan,'checkout','-q','--detach');git(orphan,'commit','-q','--allow-empty','-m','fora de ramo');
  writeFileSync(join(changed,'a.txt'),'changed\n');
  writeFileSync(join(stray,'RELATORIO.md'),'trabalho sem commit');
  // A build output that only the product's current .gitignore names (the branch predates the rule).
  writeFileSync(join(repo,'.gitignore'),'web\n');git(repo,'add','.gitignore');git(repo,'commit','-qm','ignore web');
  mkdirSync(join(built,'web'));writeFileSync(join(built,'web','index.html'),'x');
  const gone=add('sumiu');await rm(gone,{recursive:true});
  const now=Date.now()+3*HOUR;
  await utimes(recent,new Date(now),new Date(now));
  const config={storage:{productRepo:repo,worktreeIdleHours:2}};
  const deps={now:()=>now,mountInfo:rootOnly,containerMounts:async()=>[],processInside:async(path:string)=>path===busy,productRoot:join(root,'running-product')};
  const preview=(await devWorktreeRetention(config,false,deps)).join('\n');
  assert.match(preview,/1 registro\(s\) de worktree sem pasta seriam podados/);
  assert.equal(readdirSync(wt).length,9,'a preview removes nothing');
  const applied=(await devWorktreeRetention(config,true,deps)).join('\n');
  for(const name of ['integrado','build','sem-commit'])assert.match(applied,new RegExp(`${name}: removido \\(ramo task/${name} preservado\\)`));
  assert.match(applied,/nao-integrado: preservado \(ramo ainda não integrado em outro ramo\)/);
  assert.match(applied,/orfao: preservado \(commit [0-9a-f]{12} fora de qualquer ramo\)/);
  assert.match(applied,/mudanca: preservado \(há mudança rastreada\)/);
  assert.match(applied,/relatorio: preservado \(1 arquivo\(s\) não rastreado\(s\) fora das regras de ignorar, por exemplo RELATORIO\.md\)/);
  assert.match(applied,/ocupado: preservado \(há processo usando o diretório\)/);
  assert.match(applied,/recente: preservado \(atividade há 0 h/);
  assert.match(applied,/1 registro\(s\) de worktree sem pasta podado\(s\) com git worktree prune/);
  assert.deepEqual(readdirSync(wt).sort(),['mudanca','nao-integrado','ocupado','orfao','recente','relatorio']);
  for(const name of ['integrado','nao-integrado','build','sem-commit','sumiu'])assert.equal(git(repo,'rev-parse','--verify','refs/heads/task/'+name).length,40);
  assert.doesNotMatch(git(repo,'worktree','list'),/sumiu/);
  assert.ok(existsSync(join(stray,'RELATORIO.md')));
  // Without storage.productRepo nothing is touched.
  assert.deepEqual(await devWorktreeRetention({},true,deps),[]);
  void unmerged;void integrated;void fresh;
 }finally{await rm(root,{recursive:true,force:true});}
});

// ---- Report of the last run ----------------------------------------------------------------------------------------

test('every retention run leaves its report and the reason of each failure in retention-last.json',async()=>{
 const root=await base();
 try{
  const config={activation:'personal',isolation:'strict',dataDirectory:root,databaseUrl:'postgres://invalid.example/none',project:{id:randomUUID(),label:'p',repo:join(root,'repo'),owner:'o'},projects:[]} as unknown as Installation;
  const ok=async()=>['ok'];
  const deps={jobRetention:ok,jobDirRetention:ok,verifyDatabaseRetention:ok,devWorktreeRetention:ok,artifactRetention:ok,now:()=>new Date('2026-11-28T05:00:00.000Z'),
   capacityWaitRetention:async()=>{throw new Refusal('CAPACITY_WAIT_PRUNE_FAILED');}};
  const failure=await runRetentionStages(config,true,{...deps,jobRetention:async()=>{throw new Error('connect ECONNREFUSED 127.0.0.1:54329');}}).then(()=>undefined,error=>error);
  assert.ok(failure instanceof RetentionIncomplete);
  const report=await readRetentionReport(root);
  assert.equal(report?.outcome,'failed');
  assert.equal(report?.apply,true);
  assert.deepEqual(report?.failures,[
   {stage:'jobs',label:'work/ de jobs',code:'erro',detail:'Error: connect ECONNREFUSED 127.0.0.1:54329'},
   {stage:'capacity-waits',label:'esperas de capacidade',code:'CAPACITY_WAIT_PRUNE_FAILED'},
  ]);
  assert.equal(retentionSummary(report),'retention=failed(jobs:erro,capacity-waits:CAPACITY_WAIT_PRUNE_FAILED)');
  assert.ok(report!.lines.includes('ok'));
  await runRetentionStages(config,false,{...deps,capacityWaitRetention:ok});
  const second=await readRetentionReport(root);
  assert.deepEqual([second?.outcome,second?.apply,second?.failures.length],['ok',false,0]);
  assert.equal(retentionSummary(second),'retention=ok');
  assert.equal(JSON.parse(await readFile(join(root,'retention-last.json'),'utf8')).finishedAt,'2026-11-28T05:00:00.000Z');
  assert.equal(retentionSummary(await readRetentionReport(join(root,'absent'))),'retention=unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
