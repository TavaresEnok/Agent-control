import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,realpathSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {chmod,mkdtemp,readFile,rename,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Installation} from '../src/installation.ts';
import {mountPoints,mountedInside,closeRound,registerCandidateImage,registerRoundTemp,registerWorkerWorktree,runPersonalArtifactRetention,
 type CommandResult,type RetentionDeps} from '../src/personal-artifact-retention.ts';
import {RetentionIncomplete,runRetentionStages} from '../src/personal-maintenance.ts';
import {Refusal} from '../src/contracts.ts';

const HOUR=3600_000;
const gitEnv={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',
 GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid'};
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env:gitEnv,encoding:'utf8'}).trim();
const image=(c:string)=>'sha256:'+c.repeat(64);

type Lab={base:string;repo:string;data:string;tmp:string;config:Installation;projectId:string;calls:string[][];dockerCalls:string[][];deps:RetentionDeps;
 clock:{now:number};docker:{images:Map<string,{repoDigests:string[];size?:number}>;hidden:Map<string,string>;containers:Set<string>;mounts:Map<string,string[]>;alive:boolean;refuseRemoval:boolean;inspectError:boolean;free:number;reclaimPerRemoval:number};busy:Set<string>;runImages:string[]|Error};

async function lab():Promise<Lab>{
 const base=realpathSync(await mkdtemp(join(tmpdir(),'artifact-retention-')));
 const repo=join(base,'repo'),data=join(base,'data'),tmp=join(base,'tmp');
 mkdirSync(repo);mkdirSync(tmp,{mode:0o700});
 git(repo,'init','-q','-b','main');
 writeFileSync(join(repo,'a.txt'),'a\n');
 git(repo,'add','.');git(repo,'commit','-q','-m','first');
 const projectId=randomUUID();
 const config={activation:'personal',dataDirectory:data,databaseUrl:'postgres://invalid.example/none',project:{id:projectId,label:'p',repo,owner:'owner'},projects:[]} as unknown as Installation;
 const calls:string[][]=[],dockerCalls:string[][]=[];
 const docker={images:new Map<string,{repoDigests:string[];size?:number}>(),hidden:new Map<string,string>(),containers:new Set<string>(),mounts:new Map<string,string[]>(),alive:true,refuseRemoval:false,inspectError:false,free:100e9,reclaimPerRemoval:0};
 const busy=new Set<string>();
 const clock={now:Date.now()+3*HOUR};
 const result:Lab={base,repo,data,tmp,config,projectId,calls,dockerCalls,clock,docker,busy,runImages:[],deps:{},} as Lab;
 result.deps={
  now:()=>clock.now,tmpRoot:tmp,productRoot:join(base,'no-product'),sharedRefsRoot:join(base,'shared-refs'),freeBytes:async()=>docker.free,
  git:async(cwd,args):Promise<CommandResult>=>{
   calls.push(args);
   try{return {code:0,stdout:execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,env:{...gitEnv,GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',stdio:['ignore','pipe','ignore']})};}
   catch(error){return {code:(error as {status?:number}).status??1,stdout:''};}
  },
  mountInfo:async()=>mountinfo.text,
  processInside:async path=>[...busy].some(item=>path===item||path.startsWith(item+'/')),
  verifyRunImages:async()=>{if(result.runImages instanceof Error)throw result.runImages;return result.runImages;},
  docker:async args=>{
   dockerCalls.push(args);
   const [a,b]=args;
   if(a==='info')return {code:docker.alive?0:1,stdout:'daemon-test-1\n'};
   if(a==='version')return {code:docker.alive?0:1,stdout:'27.0\n'};
   if(!docker.alive)return {code:1,stdout:''};
   if(a==='image'&&b==='ls')return {code:0,stdout:[...docker.images.keys()].join('\n')+'\n'};
   if(a==='image'&&b==='inspect'){
    const id=args.at(-1)!,found=docker.images.get(id);
    if(docker.inspectError)return {code:1,stdout:'',stderr:'error during connect: context deadline exceeded'};
    if(!found)return {code:1,stdout:'',stderr:'Error response from daemon: No such image: '+id};
    return {code:0,stdout:args.includes('--format')?id+'\n':JSON.stringify([{Id:id,RepoDigests:found.repoDigests,Size:found.size}])};
   }
   if(a==='container'&&b==='ls'&&args.at(-1)==='-q')return {code:0,stdout:[...docker.mounts.keys(),...docker.hidden.keys()].join('\n')+'\n'};
   if(a==='container'&&b==='inspect'&&args.includes('{{.Image}}'))return {code:0,stdout:args.slice(4).map(id=>docker.hidden.get(id)??'sha256:'+'f'.repeat(64)).join('\n')+'\n'};
   if(a==='container'&&b==='inspect')return {code:0,stdout:args.slice(4).flatMap(id=>docker.mounts.get(id)??[]).join('\n')+'\n'};
   if(a==='container'&&b==='ls'){
    const id=args.at(-1)!.replace('ancestor=','');
    return {code:0,stdout:docker.containers.has(id)?'abc\n':''};
   }
   if(a==='image'&&b==='rm'){
    if(docker.refuseRemoval)return {code:1,stdout:''};
    docker.images.delete(args.at(-1)!);docker.free+=docker.reclaimPerRemoval;return {code:0,stdout:''};
   }
   return {code:1,stdout:''};
  },
 };
 return result;
}
const mountinfo={text:'22 1 8:1 / / rw - ext4 /dev/sda1 rw\n'};
const cleanup=(l:Lab)=>rm(l.base,{recursive:true,force:true});

/** A worker worktree on its own branch, by default with a commit already merged into `main`. */
function makeWorktree(l:Lab,name:string,options:{merged?:boolean;commit?:boolean}={}){
 const path=join(l.base,'wt',name),branch='task/'+name;
 mkdirSync(join(l.base,'wt'),{recursive:true});
 git(l.repo,'worktree','add','-q','-b',branch,path,'main');
 if(options.commit!==false){writeFileSync(join(path,name+'.txt'),name+'\n');git(path,'add','.');git(path,'commit','-q','-m',name);}
 if(options.merged!==false)git(l.repo,'merge','-q','--ff-only',branch);
 return {path,branch};
}
const register=(l:Lab,w:{path:string;branch:string},extra:{adopt?:boolean}={})=>registerWorkerWorktree(l.config,{projectId:l.projectId,path:w.path,branch:w.branch,base:'main',...extra},{...l.deps,now:()=>Date.now()});
const run=(l:Lab,apply:boolean)=>runPersonalArtifactRetention(l.config,apply,l.deps);
const branchTip=(l:Lab,branch:string)=>git(l.repo,'rev-parse','refs/heads/'+branch);

test('an integrated, clean, idle registered worktree is proposed in the preview and removed on apply, leaving its branch',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'ok'),tip=branchTip(l,w.branch);
  await register(l,w);
  const preview=await run(l,false);
  assert.match(preview.join('\n'),/elegível \(ramo task\/ok integrado em main, limpo/);
  assert.ok(existsSync(w.path));
  assert.equal(existsSync(join(l.data,'artifact-retention','registry.json')),true);
  const before=await readFile(join(l.data,'artifact-retention','registry.json'),'utf8');
  const applied=await run(l,true);
  assert.match(applied.join('\n'),/removido \(ramo task\/ok preservado\)/);
  assert.equal(existsSync(w.path),false);
  assert.equal(branchTip(l,w.branch),tip);
  assert.doesNotMatch(git(l.repo,'worktree','list'),/wt\/ok/);
  const after=JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8'));
  assert.equal(after.worktrees.length,0);
  assert.equal(after.history.at(-1).action,'removed');
  assert.notEqual(before,JSON.stringify(after));
  // A second run has nothing left to do.
  assert.match((await run(l,true)).at(-1)!,/worktrees 0 removido\(s\) e 0 preservado/);
  assert.equal(statSync(join(l.data,'artifact-retention','registry.json')).mode&0o077,0);
 }finally{await cleanup(l);}
});

test('preserves tracked edits hidden by either index flag',async()=>{
 const l=await lab();
 try{
  for(const [name,flag] of [['assumed','--assume-unchanged'],['skipped','--skip-worktree']]){
   const w=makeWorktree(l,name);
   await register(l,w);
   git(w.path,'update-index',flag,name+'.txt');
   writeFileSync(join(w.path,name+'.txt'),'local change');
   assert.match((await run(l,true)).join('\n'),/índice contém arquivos ocultos/);
   assert.equal(await readFile(join(w.path,name+'.txt'),'utf8'),'local change');
  }
 }finally{await cleanup(l);}
});

test('the preview never changes the registry, git or the disk',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'peek');
  await register(l,w);
  const file=join(l.data,'artifact-retention','registry.json');
  const before=await readFile(file,'utf8');
  await run(l,false);
  assert.equal(await readFile(file,'utf8'),before);
  assert.ok(existsSync(w.path));
  assert.equal(l.calls.some(args=>args[0]==='worktree'&&args[1]==='remove'),false);
 }finally{await cleanup(l);}
});

test('a worktree is kept for every unmet proof, and git never prunes, forces or deletes a branch',async()=>{
 const l=await lab();
 try{
  const dirty=makeWorktree(l,'dirty');writeFileSync(join(dirty.path,'untracked.txt'),'x');
  const modified=makeWorktree(l,'modified');writeFileSync(join(modified.path,'modified.txt'),'changed\n');
  const unmerged=makeWorktree(l,'unmerged',{merged:false});
  const ahead=makeWorktree(l,'ahead');writeFileSync(join(ahead.path,'more.txt'),'m');git(ahead.path,'add','.');git(ahead.path,'commit','-q','-m','more');
  const detached=makeWorktree(l,'detached');git(detached.path,'checkout','-q','--detach');
  const locked=makeWorktree(l,'locked');git(l.repo,'worktree','lock',locked.path);
  const alive=makeWorktree(l,'alive');l.busy.add(alive.path);
  const ignored=makeWorktree(l,'ignored');
  writeFileSync(join(ignored.path,'.gitignore'),'secret.env\n');git(ignored.path,'add','.');git(ignored.path,'commit','-q','-m','ig');git(l.repo,'merge','-q','--ff-only',ignored.branch);
  writeFileSync(join(ignored.path,'secret.env'),'token');
  const merging=makeWorktree(l,'merging');
  writeFileSync(join(git(merging.path,'rev-parse','--absolute-git-dir'),'MERGE_HEAD'),git(l.repo,'rev-parse','HEAD')+'\n');
  const all=[dirty,modified,unmerged,ahead,detached,locked,alive,ignored,merging];
  // The detached one must be registered while still on its branch, as a worker would have been.
  git(detached.path,'checkout','-q',detached.branch);
  for(const item of all)await register(l,item);
  git(detached.path,'checkout','-q','--detach');
  const tips=new Map(all.map(item=>[item.branch,branchTip(l,item.branch)]));
  const lines=(await run(l,true)).join('\n');
  for(const item of all){assert.ok(existsSync(item.path),item.path+' must stay');assert.equal(branchTip(l,item.branch),tips.get(item.branch));}
  assert.match(lines,/dirty: preservado \(há mudanças ou arquivos não rastreados\)/);
  assert.match(lines,/modified: preservado \(há mudanças/);
  assert.match(lines,/unmerged: preservado \(ramo ainda não integrado em main\)/);
  assert.match(lines,/ahead: preservado \(o ramo e o HEAD do worktree divergem|ahead: preservado \(ramo ainda não integrado/);
  assert.match(lines,/detached: preservado \(o worktree não está no ramo registrado\)/);
  assert.match(lines,/locked: preservado \(worktree travado\)/);
  assert.match(lines,/alive: preservado \(há processo usando o diretório\)/);
  assert.match(lines,/ignored: preservado \(há arquivos ignorados com conteúdo próprio\)/);
  assert.match(lines,/merging: preservado \(operação do git em andamento\)/);
  assert.match(lines.split('\n').at(-1)!,/worktrees 0 removido\(s\) e 9 preservado/);
  const forbidden=l.calls.filter(args=>args.includes('prune')||args.includes('--force')||args.includes('-f')||args.includes('-D')||args.includes('-d')||(args[0]==='branch'));
  assert.deepEqual(forbidden,[]);
  assert.deepEqual(l.calls.filter(args=>args[0]==='worktree'&&args[1]==='remove'),[]);
 }finally{await cleanup(l);}
});

test('a worktree younger than two hours is kept, and the clock starts at the newest sign of activity',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'young');
  await register(l,w);
  l.clock.now=Date.now()+HOUR;
  assert.match((await run(l,true)).join('\n'),/young: preservado \(atividade há 1 h \(mínimo 2 h\)\)/);
  assert.ok(existsSync(w.path));
  l.clock.now=Date.now()+2*HOUR+60_000;
  assert.match((await run(l,true)).join('\n'),/young: removido/);
 }finally{await cleanup(l);}
});

test('only registered worktrees are ever considered, whatever their name, branch or age',async()=>{
 const l=await lab();
 try{
  const stranger=makeWorktree(l,'stranger');
  const owned=makeWorktree(l,'owned');
  await register(l,owned);
  const old=new Date(Date.now()-48*HOUR);
  await utimes(stranger.path,old,old);
  const lines=(await run(l,true)).join('\n');
  assert.ok(existsSync(stranger.path));
  assert.doesNotMatch(lines,/stranger/);
  assert.equal(existsSync(owned.path),false);
  // The main checkout can never be registered, and neither can an unlisted directory or a missing integration branch.
  await assert.rejects(registerWorkerWorktree(l.config,{projectId:l.projectId,path:l.repo,branch:'main',base:'main'},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  const plain=join(l.base,'plain');mkdirSync(plain);
  await assert.rejects(registerWorkerWorktree(l.config,{projectId:l.projectId,path:plain,branch:'x',base:'main'},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerWorkerWorktree(l.config,{projectId:l.projectId,path:stranger.path,branch:stranger.branch,base:'nope'},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerWorkerWorktree(l.config,{projectId:l.projectId,path:stranger.path,branch:'task/other',base:'main'},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerWorkerWorktree(l.config,{projectId:randomUUID(),path:stranger.path,branch:stranger.branch,base:'main'},l.deps),{code:'RETENTION_PROJECT_UNKNOWN'});
 }finally{await cleanup(l);}
});

test('adoption of an existing worktree is accepted only on git proof, records its origin and is idempotent',async()=>{
 const l=await lab();
 try{
  const old=makeWorktree(l,'existing');
  const first=await register(l,old,{adopt:true}),second=await register(l,old,{adopt:true});
  assert.equal(first,second);
  const registry=JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8'));
  assert.equal(registry.worktrees.length,1);assert.equal(registry.worktrees[0].origin,'existing');
  await assert.rejects(registerWorkerWorktree(l.config,{projectId:l.projectId,path:old.path,branch:old.branch,base:'master'},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerWorkerWorktree(l.config,{projectId:l.projectId,path:old.path,branch:old.branch,base:'main'},{...l.deps,git:async()=>({code:1,stdout:''})}),{code:'RETENTION_REGISTRATION_INVALID'});
 }finally{await cleanup(l);}
});

test('a registered path that was replaced, moved to another branch or left to another project is kept',async()=>{
 const l=await lab();
 try{
  const switched=makeWorktree(l,'switched');
  await register(l,switched);
  git(switched.path,'checkout','-q','-b','task/elsewhere');
  const swapped=makeWorktree(l,'swapped');
  await register(l,swapped);
  git(l.repo,'worktree','remove',swapped.path);
  symlinkSync(switched.path,swapped.path);
  const lines=(await run(l,true)).join('\n');
  assert.match(lines,/switched: preservado \(o worktree não está no ramo registrado\)/);
  assert.match(lines,/swapped: preservado/);
  assert.ok(existsSync(switched.path));
  assert.ok(existsSync(swapped.path));
  // An entry whose project is not in this installation is left alone.
  const registryPath=join(l.data,'artifact-retention','registry.json');
  const registry=JSON.parse(await readFile(registryPath,'utf8'));
  registry.worktrees[0].projectId=randomUUID();
  await writeFile(registryPath,JSON.stringify(registry),{mode:0o600});
  assert.match((await run(l,true)).join('\n'),/projeto fora desta instalação/);
 }finally{await cleanup(l);}
});

test('an entry whose worktree is gone from git and disk loses only its registry line; a git-only leftover is not pruned',async()=>{
 const l=await lab();
 try{
  const gone=makeWorktree(l,'gone');
  await register(l,gone);
  git(l.repo,'worktree','remove',gone.path);
  const leftover=makeWorktree(l,'leftover');
  await register(l,leftover);
  await rm(leftover.path,{recursive:true,force:true});
  const preview=(await run(l,false)).join('\n');
  assert.match(preview,/gone: registro seria retirado/);
  assert.match(preview,/leftover: preservado \(diretório ausente; registro do git exige revisão manual\)/);
  const applied=(await run(l,true)).join('\n');
  assert.match(applied,/gone: registro retirado/);
  assert.match(git(l.repo,'worktree','list','--porcelain'),/leftover/);
  assert.equal(l.calls.some(args=>args.includes('prune')),false);
  const registry=JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8'));
  assert.deepEqual(registry.worktrees.map((item:{path:string})=>item.path),[leftover.path]);
 }finally{await cleanup(l);}
});

test('a damaged or foreign registry stops the run before anything is touched',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'guarded');
  await register(l,w);
  const file=join(l.data,'artifact-retention','registry.json');
  await writeFile(file,'{"schemaVersion":1,"worktrees":[{"path":"/etc"}]}',{mode:0o600});
  await assert.rejects(run(l,true),{code:'RETENTION_REGISTRY_INVALID'});
  await writeFile(file,'{"schemaVersion":1,"worktrees":[],"images":[],"temps":[],"rounds":[],"history":[],"extra":1}',{mode:0o600});
  await assert.rejects(run(l,true),{code:'RETENTION_REGISTRY_INVALID'});
  await writeFile(file,JSON.stringify({schemaVersion:1,worktrees:[],images:[],temps:[],rounds:[],history:[]}));
  await chmod(file,0o644);
  await assert.rejects(run(l,false),{code:'RETENTION_REGISTRY_INVALID'});
  assert.ok(existsSync(w.path));
  await assert.rejects(runPersonalArtifactRetention({...l.config,activation:'locked'} as Installation,true,l.deps),{code:'MAINTENANCE_PERSONAL_REQUIRED'});
 }finally{await cleanup(l);}
});

// ---- Images ----

const digestFile=(root:string,module:string,text:string)=>{mkdirSync(join(root,'deploy','modules',module),{recursive:true});writeFileSync(join(root,'deploy','modules',module,'digest.txt'),text+'\n');};

const DAY=24*HOUR;
const registerOld=(l:Lab,id:string,module:'qa'|'banco'='qa',ageMs=3*DAY)=>registerCandidateImage(l.config,{projectId:l.projectId,module,imageId:id},{...l.deps,now:()=>l.clock.now-ageMs});
const removals=(l:Lab)=>l.dockerCalls.filter(args=>args[0]==='image'&&args[1]==='rm');

test('an unused, unpinned registered candidate older than 24 h is listed in the preview and removed on apply by id, never forced',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[],size:2_500_000_000});l.docker.images.set(image('b'),{repoDigests:[]});
  await registerOld(l,image('a'));
  const preview=(await run(l,false)).join('\n');
  assert.match(preview,/imagem sha256:aaaaaaaaaaaa \(qa\): elegível \(.*2\.500 GB nominais/);
  assert.match(preview,/imagens: elegíveis 1, 2\.500 GB/);
  assert.ok(l.docker.images.has(image('a')));
  assert.deepEqual(removals(l),[]);
  const applied=(await run(l,true)).join('\n');
  assert.match(applied,/imagem sha256:aaaaaaaaaaaa \(qa\): removida \(2\.500 GB nominais\)/);
  assert.match(applied,/imagens: removidas 1, 2\.500 GB/);
  assert.match(applied,/imagens 1 removido\(s\) e 0 preservada\(s\)/);
  assert.equal(l.docker.images.has(image('a')),false);
  assert.ok(l.docker.images.has(image('b')),'an unregistered image is never touched');
  assert.deepEqual(removals(l),[['image','rm',image('a')]]);
  assert.equal(l.dockerCalls.some(args=>args.includes('prune')||args.includes('-f')||args.includes('--force')||args.includes('rmi')),false);
  const registry=JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8'));
  assert.equal(registry.images.length,0);
  assert.equal(registry.history.at(-1).action,'removed');
 }finally{await cleanup(l);}
});

test('an image stays when pinned by a product or project digest.txt, by the native bootstrap, by a retired entry, by a verification run, by a container (running, stopped or hidden from the ancestor filter) or when younger than 24 h',async()=>{
 const l=await lab();
 try{
  const kinds=['1','2','3','4','5','6','7','8','9'];
  for(const k of kinds)l.docker.images.set(image(k),{repoDigests:k==='2'?['registry.example/mod@'+image('c')]:[]});
  for(const k of kinds)await registerOld(l,image(k),'banco',k==='6'?DAY-HOUR:3*DAY);
  digestFile(l.deps.productRoot!,'qa',image('1'));
  digestFile(l.repo,'banco','registry.example/mod@'+image('c'));
  (l.config as unknown as {nativeBootstrap:unknown}).nativeBootstrap={qa:{image:image('3')},planning:{imageId:image('d'),retiredImageIds:[image('7')]},
   execution:{workerImage:image('d'),toolsImage:image('e'),retiredImages:[{workerImage:image('8'),toolsImage:image('e')}]}};
  l.runImages=[image('4')];
  l.docker.containers.add(image('5'));
  l.docker.hidden.set('stopped1',image('9'));
  const text=(await run(l,true)).join('\n');
  assert.equal(l.docker.images.size,9);
  assert.deepEqual(removals(l),[]);
  assert.match(text,/sha256:111111111111 \(banco\): preservado \(digest fixado ou referenciado por exame\)/);
  assert.match(text,/sha256:222222222222 \(banco\): preservado \(digest fixado/);
  assert.match(text,/sha256:333333333333 \(banco\): preservado \(digest fixado/);
  assert.match(text,/sha256:444444444444 \(banco\): preservado \(digest fixado/);
  assert.match(text,/sha256:555555555555 \(banco\): preservado \(há contêiner usando a imagem\)/);
  assert.match(text,/sha256:666666666666 \(banco\): preservado \(registrada há 23 h \(mínimo 24 h\)\)/);
  assert.match(text,/sha256:777777777777 \(banco\): preservado \(imagem aposentada ainda referenciada/);
  assert.match(text,/sha256:888888888888 \(banco\): preservado \(imagem aposentada ainda referenciada/);
  assert.match(text,/sha256:999999999999 \(banco\): preservado \(há contêiner usando a imagem\)/);
  assert.match(text,/imagens 0 removido\(s\) e 9 preservada\(s\)/);
  // Once the blockers are gone, only the three that were never blocked by anything else go.
  l.docker.containers.delete(image('5'));l.docker.hidden.clear();l.runImages=[];
  (l.config as unknown as {nativeBootstrap:unknown}).nativeBootstrap=undefined;
  rmSync(join(l.deps.productRoot!,'deploy'),{recursive:true,force:true});rmSync(join(l.repo,'deploy'),{recursive:true,force:true});
  l.clock.now+=2*HOUR;
  await run(l,true);
  assert.deepEqual([...l.docker.images.keys()],[]);
 }finally{await cleanup(l);}
});

test('the per-project switch economy.imageRetention=false keeps that project images, and the preview never changes anything',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});
  await registerOld(l,image('a'));
  (l.config.project as unknown as {economy:{imageRetention:boolean}}).economy={imageRetention:false};
  const text=(await run(l,true)).join('\n');
  assert.match(text,/preservado \(retenção de imagens desligada neste projeto\)/);
  assert.ok(l.docker.images.has(image('a')));
  assert.deepEqual(removals(l),[]);
  (l.config.project as unknown as {economy:{imageRetention:boolean}}).economy={imageRetention:true};
  const registryBefore=await readFile(join(l.data,'artifact-retention','registry.json'),'utf8');
  await run(l,false);
  assert.equal(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8'),registryBefore);
  assert.ok(l.docker.images.has(image('a')));
 }finally{await cleanup(l);}
});

test('unreadable pins, unavailable Docker, a refusal by Docker and absent images never remove an image',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});l.docker.images.set(image('b'),{repoDigests:[]});
  await registerOld(l,image('a'));await registerOld(l,image('b'));
  l.runImages=new Error('db down');
  assert.match((await run(l,true)).join('\n'),/preservado \(não foi possível ler os digests fixados e os exames\)/);
  l.runImages=[];
  const mode=join(l.deps.productRoot!,'deploy','modules','qa','digest.txt');
  mkdirSync(mode,{recursive:true});// a directory where the file should be: a read error, not "missing"
  assert.match((await run(l,true)).join('\n'),/não foi possível ler os digests fixados/);
  await rm(l.deps.productRoot!,{recursive:true,force:true});
  l.docker.alive=false;
  assert.match((await run(l,true)).join('\n'),/preservado \(identidade do daemon Docker indisponível\)/);
  l.docker.alive=true;
  l.docker.refuseRemoval=true;
  assert.match((await run(l,true)).join('\n'),/preservado \(o Docker recusou a remoção\)/);
  assert.equal(l.docker.images.size,2);
  l.docker.refuseRemoval=false;
  l.docker.images.delete(image('b'));
  const text=(await run(l,false)).join('\n');
  assert.match(text,/sha256:bbbbbbbbbbbb \(qa\): registro seria retirado \(a imagem já não existe no Docker\)/);
  const applied=(await run(l,true)).join('\n');
  assert.match(applied,/sha256:bbbbbbbbbbbb \(qa\): registro retirado \(a imagem já não existe no Docker\)/);
  assert.equal(l.docker.images.size,0,'image a was removed only once nothing blocked it');
 }finally{await cleanup(l);}
});

test('a change between the proof and the removal (a container appears) keeps the image',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});
  await registerOld(l,image('a'));
  const original=l.deps.docker!;
  let looks=0;
  l.deps.docker=async args=>{
   if(args[0]==='container'&&args[1]==='ls'&&args.includes('--filter')&&++looks===2)l.docker.containers.add(image('a'));
   return original(args);
  };
  const text=(await run(l,true)).join('\n');
  assert.match(text,/preservado \(mudou durante a retenção: há contêiner usando a imagem\)/);
  assert.ok(l.docker.images.has(image('a')));
  assert.deepEqual(removals(l),[]);
 }finally{await cleanup(l);}
});

test('a candidate image is registered only if Docker has exactly that id',async()=>{
 const l=await lab();
 try{
  await assert.rejects(registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('c')},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:'registry/qa:latest'},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerCandidateImage(l.config,{projectId:l.projectId,module:'nao-existe' as never,imageId:image('c')},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  l.docker.images.set(image('c'),{repoDigests:[]});
  const id=await registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('c')},l.deps);
  assert.equal(await registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('c')},l.deps),id);
  await assert.rejects(registerCandidateImage(l.config,{projectId:l.projectId,module:'banco',imageId:image('c')},l.deps),{code:'RETENTION_REGISTRATION_CONFLICT'});
 }finally{await cleanup(l);}
});


test('registration refuses unavailable, malformed or changing daemon identities',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});
  const docker=l.deps.docker!;
  for(const value of ['', 'bad id']){
   l.deps.docker=async args=>args[0]==='info'?{code:0,stdout:value}:docker(args);
   await assert.rejects(registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('a')},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  }
  let count=0;
  l.deps.docker=async args=>args[0]==='info'?{code:0,stdout:++count===1?'daemon-a':'daemon-b'}:docker(args);
  await assert.rejects(registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('a')},l.deps),{code:'RETENTION_REGISTRATION_INVALID'});
  assert.equal(existsSync(join(l.data,'artifact-retention','registry.json')),false);
 }finally{await cleanup(l);}
});

test('daemon identity is bound to registration; legacy and changed daemons preserve the image',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});
  await registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('a')},l.deps);
  const file=join(l.data,'artifact-retention','registry.json');
  const registry=JSON.parse(await readFile(file,'utf8'));
  assert.equal(registry.images[0].daemonId,'daemon-test-1');
  const docker=l.deps.docker!;
  l.deps.docker=async args=>args[0]==='info'?{code:0,stdout:'daemon-test-2'}:docker(args);
  assert.match((await run(l,true)).join('\n'),/daemon Docker diferente do registro/);
  delete registry.images[0].daemonId;
  await writeFile(file,JSON.stringify(registry),{mode:0o600});
  assert.match((await run(l,true)).join('\n'),/registro antigo sem identidade do daemon/);
  assert.ok(l.docker.images.has(image('a')));
  assert.equal(l.dockerCalls.some(args=>args[0]==='image'&&args[1]==='rm'),false);
 }finally{await cleanup(l);}
});

// ---- Temporaries ----

function makeTemp(l:Lab,name:string){const path=join(l.tmp,name);mkdirSync(path,{mode:0o700});writeFileSync(join(path,'data.bin'),'x');mkdirSync(join(path,'oci'));writeFileSync(join(path,'oci','layer'),'y');return path;}
const registerTemp=(l:Lab,path:string,roundId='round-1')=>registerRoundTemp(l.config,{projectId:l.projectId,roundId,path},{...l.deps,now:()=>Date.now()});

test('a registered temporary of a round closed more than 24 h ago is removed; the same name without proof never is',async()=>{
 const l=await lab();
 try{
  const owned=makeTemp(l,'ac-retomada-aaaa-1'),stranger=makeTemp(l,'ac-retomada-bbbb-2'),other=makeTemp(l,'outro-diretorio');
  await registerTemp(l,owned);
  const old=new Date(Date.now()-72*HOUR);
  for(const path of [owned,stranger,other])await utimes(path,old,old);
  // Round still open: kept.
  assert.match((await run(l,true)).join('\n'),/ac-retomada-aaaa-1: preservado \(rodada sem prova de encerramento\)/);
  await closeRound(l.config,{projectId:l.projectId,roundId:'round-1'},{...l.deps,now:()=>Date.now()});
  l.clock.now=Date.now()+23*HOUR;
  assert.match((await run(l,true)).join('\n'),/preservado \(rodada encerrada há 23 h \(mínimo 24 h\)\)/);
  assert.ok(existsSync(owned));
  l.clock.now=Date.now()+25*HOUR;
  const preview=(await run(l,false)).join('\n');
  assert.match(preview,/ac-retomada-aaaa-1: elegível \(rodada round-1 encerrada há 25 h\)/);
  assert.ok(existsSync(owned));
  const applied=(await run(l,true)).join('\n');
  assert.match(applied,/ac-retomada-aaaa-1: removido/);
  assert.match(applied,/1 item\(ns\) ac-\* no diretório temporário sem registro de propriedade: preservado/);
  assert.equal(existsSync(owned),false);
  assert.ok(existsSync(stranger));assert.ok(existsSync(other));
  assert.equal(JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8')).temps.length,0);
 }finally{await cleanup(l);}
});

test('a temporary is kept when its marker, identity, location, process or contents do not match',async()=>{
 const l=await lab();
 try{
  const noMarker=makeTemp(l,'ac-no-marker'),swapped=makeTemp(l,'ac-swapped'),busy=makeTemp(l,'ac-busy'),link=makeTemp(l,'ac-link');
  const target=makeTemp(l,'ac-target');
  for(const path of [noMarker,swapped,busy,link])await registerTemp(l,path);
  await rm(join(noMarker,'.ac-retention-owner'));
  await rename(swapped,swapped+'-moved');mkdirSync(swapped,{mode:0o700});writeFileSync(join(swapped,'.ac-retention-owner'),'{}');
  l.busy.add(busy);
  await rm(link,{recursive:true});symlinkSync(target,link);
  await closeRound(l.config,{projectId:l.projectId,roundId:'round-1'},{...l.deps,now:()=>Date.now()});
  l.clock.now=Date.now()+30*HOUR;
  const text=(await run(l,true)).join('\n');
  assert.match(text,/ac-no-marker: preservado \(marca de propriedade ausente\)/);
  assert.match(text,/ac-swapped: preservado \(o diretório não é o registrado\)/);
  assert.match(text,/ac-busy: preservado \(há processo usando o diretório\)/);
  assert.match(text,/ac-link: preservado \(o diretório não é o registrado\)/);
  for(const path of [noMarker,swapped,busy,target])assert.ok(existsSync(path));
  assert.ok(existsSync(join(target,'data.bin')),'a symlink never leads the removal elsewhere');
  // A container that bind-mounts the directory keeps it, even though no host process shows up.
  const mounted=makeTemp(l,'ac-mounted');
  await registerTemp(l,mounted,'round-3');
  await closeRound(l.config,{projectId:l.projectId,roundId:'round-3'},{...l.deps,now:()=>Date.now()});
  l.docker.mounts.set('c1',[join(mounted,'oci')]);
  assert.match((await run(l,true)).join('\n'),/ac-mounted: preservado \(há contêiner com este diretório montado\)/);
  assert.ok(existsSync(mounted));
  l.docker.alive=false;
  assert.match((await run(l,true)).join('\n'),/ac-mounted: preservado \(não foi possível provar que nenhum contêiner monta o diretório\)/);
  l.docker.alive=true;l.docker.mounts.clear();
  // A forged marker with the right entry id but another secret does not prove ownership either.
  const forged=makeTemp(l,'ac-forged');
  const id=await registerTemp(l,forged,'round-2');
  await writeFile(join(forged,'.ac-retention-owner'),JSON.stringify({schemaVersion:1,entryId:id,nonce:'guess'}));
  await closeRound(l.config,{projectId:l.projectId,roundId:'round-2'},{...l.deps,now:()=>Date.now()});
  assert.match((await run(l,true)).join('\n'),/ac-forged: preservado \(marca de propriedade não confere\)/);
  assert.ok(existsSync(forged));
 }finally{await cleanup(l);}
});

test('only direct children of the temporary root named ac-* can be registered',async()=>{
 const l=await lab();
 try{
  const nested=join(l.tmp,'ac-parent');mkdirSync(nested);mkdirSync(join(nested,'ac-child'));
  const plain=makeTemp(l,'plain');
  await assert.rejects(registerTemp(l,join(nested,'ac-child')),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerTemp(l,plain),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerTemp(l,join(l.tmp,'ac-missing')),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerTemp(l,l.tmp),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerTemp(l,nested,'bad round'),{code:'RETENTION_REGISTRATION_INVALID'});
  await assert.rejects(registerRoundTemp(l.config,{projectId:randomUUID(),roundId:'r',path:nested},l.deps),{code:'RETENTION_PROJECT_UNKNOWN'});
  const id=await registerTemp(l,nested);
  assert.equal(await registerTemp(l,nested),id);
  await assert.rejects(registerTemp(l,nested,'another-round'),{code:'RETENTION_REGISTRATION_CONFLICT'});
  const link=join(l.tmp,'ac-link');symlinkSync(nested,link);
  await assert.rejects(registerTemp(l,link),{code:'RETENTION_REGISTRATION_INVALID'});
 }finally{await cleanup(l);}
});

test('closing a round keeps the first end time',async()=>{
 const l=await lab();
 try{
  const first=await closeRound(l.config,{projectId:l.projectId,roundId:'r1'},{now:()=>1000});
  const second=await closeRound(l.config,{projectId:l.projectId,roundId:'r1'},{now:()=>9000});
  assert.equal(first,1000);assert.equal(second,1000);
  await assert.rejects(closeRound(l.config,{projectId:randomUUID(),roundId:'r1'}),{code:'RETENTION_PROJECT_UNKNOWN'});
 }finally{await cleanup(l);}
});

test('one failing artifact does not stop the others',async()=>{
 const l=await lab();
 try{
  const a=makeWorktree(l,'first'),b=makeWorktree(l,'second');
  await register(l,a);await register(l,b);
  const failing:RetentionDeps={...l.deps,git:async(cwd,args)=>{
   if(args[0]==='worktree'&&args[1]==='remove'&&args.at(-1)!.startsWith(join(l.base,'wt','.ac-retention-'))&&!existsSync(join(args.at(-1)!,'second.txt')))return {code:1,stdout:''};
   return l.deps.git!(cwd,args);
  }};
  const lines=(await runPersonalArtifactRetention(l.config,true,failing)).join('\n');
  assert.match(lines,/first: preservado \(o git recusou a remoção\)/);
  assert.match(lines,/second: removido/);
  assert.ok(existsSync(a.path));assert.equal(existsSync(b.path),false);
 }finally{await cleanup(l);}
});

test('the default process check sees a real process whose working directory is inside the artifact',async()=>{
 const l=await lab();
 const {spawn}=await import('node:child_process');
 let child:ReturnType<typeof spawn>|undefined;
 try{
  const path=makeTemp(l,'ac-live-process');
  await registerTemp(l,path);
  await closeRound(l.config,{projectId:l.projectId,roundId:'round-1'},{...l.deps,now:()=>Date.now()});
  l.clock.now=Date.now()+30*HOUR;
  const real:RetentionDeps={...l.deps};delete real.processInside;
  child=spawn('sleep',['30'],{cwd:join(path,'oci'),stdio:'ignore'});
  await new Promise(done=>child!.once('spawn',done));
  assert.match((await runPersonalArtifactRetention(l.config,true,real)).join('\n'),/preservado \(há processo usando o diretório\)/);
  assert.ok(existsSync(path));
  child.kill();await new Promise(done=>child!.once('exit',done));
  assert.match((await runPersonalArtifactRetention(l.config,true,real)).join('\n'),/ac-live-process: removido/);
  assert.equal(existsSync(path),false);
 }finally{child?.kill();await cleanup(l);}
});

test('preserves a different worktree recreated on the registered branch and path',async()=>{
 const l=await lab();
 try{
  const worker=makeWorktree(l,'recreated');
  await register(l,worker);
  git(l.repo,'worktree','remove',worker.path);
  git(l.repo,'worktree','add',worker.path,worker.branch);
  assert.match((await run(l,true)).join('\n'),/identidade do worktree mudou/);
  assert.ok(existsSync(worker.path));
 }finally{await cleanup(l);}
});

test('preserves both directories if the temporary path changes during the final Docker check',async()=>{
 const l=await lab();
 try{
  const dir=makeTemp(l,'ac-swap-final');
  await registerTemp(l,dir);
  await closeRound(l.config,{projectId:l.projectId,roundId:'round-1'},{...l.deps,now:Date.now});
  l.clock.now=Date.now()+25*HOUR;
  const docker=l.deps.docker!;
  let checks=0;
  l.deps.docker=async args=>{
   if(args[0]==='container'&&args[1]==='ls'&&++checks===2){
    await rename(dir,dir+'.original');
    makeTemp(l,'ac-swap-final');
   }
   return docker(args);
  };
  await run(l,true);
  assert.equal(checks,2);
  assert.ok(existsSync(join(dir,'data.bin')));
  assert.ok(existsSync(join(dir+'.original','data.bin')));
 }finally{await cleanup(l);}
});

test('concurrent candidate registrations persist and images remain protected',async()=>{
 const l=await lab();
 try{
  const ids=['a','b','c','d'].map(image);
  for(const id of ids)l.docker.images.set(id,{repoDigests:[]});
  await Promise.all(ids.map(imageId=>registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId},{...l.deps,now:Date.now})));
  const reg=JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8'));
  assert.equal(reg.images.length,4);
  await run(l,true);
  assert.equal(l.dockerCalls.some(args=>args[0]==='image'&&args[1]==='rm'),false);
  assert.ok(l.docker.images.has(ids[0]!));
 }finally{await cleanup(l);}
});

// ---- Ignored files, interrupted temporaries and independent stages ----

/** A merged worker worktree whose .gitignore covers dist/, coverage/, node_modules and build/. */
function ignoringWorktree(l:Lab,name:string){
 const w=makeWorktree(l,name);
 writeFileSync(join(w.path,'.gitignore'),'dist/\ncoverage/\nnode_modules\nbuild/\n');
 git(w.path,'add','.');git(w.path,'commit','-q','--allow-empty','-m','ignore');git(l.repo,'merge','-q','--ff-only',w.branch);
 return w;
}

test('a name such as dist, coverage or node_modules never proves that ignored contents are disposable',async()=>{
 const l=await lab();
 try{
  const dist=ignoringWorktree(l,'dist');mkdirSync(join(dist.path,'cliente','dist'),{recursive:true});writeFileSync(join(dist.path,'cliente','dist','unico.bin'),'only copy');
  const coverage=ignoringWorktree(l,'coverage');mkdirSync(join(coverage.path,'coverage'));writeFileSync(join(coverage.path,'coverage','lcov.info'),'x');
  const modules=ignoringWorktree(l,'modules');mkdirSync(join(modules.path,'node_modules','pacote'),{recursive:true});writeFileSync(join(modules.path,'node_modules','pacote','patched.js'),'local edit');
  const file=ignoringWorktree(l,'file');writeFileSync(join(file.path,'node_modules'),'a regular file named node_modules');
  const all=[dist,coverage,modules,file];
  for(const item of all)await register(l,item);
  const lines=(await run(l,true)).join('\n');
  for(const item of all){
   assert.ok(existsSync(item.path),item.path+' must stay');
   assert.match(lines,new RegExp(`wt/${item.path.split('/').at(-1)}: preservado \\(há arquivos ignorados com conteúdo próprio\\)`));
  }
  assert.ok(existsSync(join(dist.path,'cliente','dist','unico.bin')));
  assert.ok(existsSync(join(modules.path,'node_modules','pacote','patched.js')));
  assert.deepEqual(l.calls.filter(args=>args[0]==='worktree'&&args[1]==='remove'),[]);
 }finally{await cleanup(l);}
});

test('an ignored symbolic link is the only ignored entry that may go, and its target is never touched',async()=>{
 const l=await lab();
 try{
  const shared=join(l.base,'shared-node-modules');mkdirSync(join(shared,'pacote'),{recursive:true});writeFileSync(join(shared,'pacote','index.js'),'kept');
  const linked=ignoringWorktree(l,'linked');symlinkSync(shared,join(linked.path,'node_modules'));
  const mixed=ignoringWorktree(l,'mixed');symlinkSync(shared,join(mixed.path,'node_modules'));mkdirSync(join(mixed.path,'build'));writeFileSync(join(mixed.path,'build','out.bin'),'own');
  await register(l,linked);await register(l,mixed);
  const lines=(await run(l,true)).join('\n');
  assert.match(lines,/wt\/linked: removido \(ramo task\/linked preservado\)/);
  assert.match(lines,/wt\/mixed: preservado \(há arquivos ignorados com conteúdo próprio\)/);
  assert.equal(existsSync(linked.path),false);
  assert.ok(existsSync(join(mixed.path,'build','out.bin')));
  assert.equal(await readFile(join(shared,'pacote','index.js'),'utf8'),'kept');
 }finally{await cleanup(l);}
});

const registryPath=(l:Lab)=>join(l.data,'artifact-retention','registry.json');
async function closedTemp(l:Lab,name:string){
 const path=makeTemp(l,name);
 const id=await registerTemp(l,path);
 await closeRound(l.config,{projectId:l.projectId,roundId:'round-1'},{...l.deps,now:()=>Date.now()});
 l.clock.now=Date.now()+25*HOUR;
 return {path,id};
}
const birthOf=(path:string)=>String(statSync(path,{bigint:true}).birthtimeNs);

test('a temporary whose removal stopped after its marker was deleted is finished by the next run from the external journal',async()=>{
 const l=await lab();
 try{
  const {path}=await closedTemp(l,'ac-interrompido');
  // A subdirectory the helper cannot empty makes the first removal stop midway, after the journal was written.
  const stuck=join(path,'preso');mkdirSync(stuck);writeFileSync(join(stuck,'x'),'x');await chmod(stuck,0o500);
  const first=(await run(l,true)).join('\n');
  assert.match(first,/ac-interrompido: preservado \(falha ao remover; repita depois\)/);
  assert.ok(existsSync(path));
  const journal=JSON.parse(await readFile(registryPath(l),'utf8')).temps[0].removing;
  assert.equal(journal.birth,birthOf(path));
  // The interruption may have taken the marker with it: only the journal is left as proof.
  await rm(join(path,'.ac-retention-owner'),{force:true});
  await chmod(stuck,0o700);
  assert.match((await run(l,false)).join('\n'),/ac-interrompido: elegível \(rodada round-1 encerrada há 25 h, retomando remoção interrompida\)/);
  const second=(await run(l,true)).join('\n');
  assert.match(second,/ac-interrompido: removido, retomando remoção interrompida/);
  assert.equal(existsSync(path),false);
  const after=JSON.parse(await readFile(registryPath(l),'utf8'));
  assert.equal(after.temps.length,0);assert.equal(after.history.at(-1).action,'removed');
 }finally{await chmod(join(l.tmp,'ac-interrompido','preso'),0o700).catch(()=>{});await cleanup(l);}
});

test('the removal journal never vouches for another directory, and without it a missing marker still keeps the directory',async()=>{
 const l=await lab();
 try{
  const {path,id}=await closedTemp(l,'ac-jornal');
  const registry=JSON.parse(await readFile(registryPath(l),'utf8'));
  registry.temps[0].removing={since:Date.now(),birth:birthOf(path)};
  await writeFile(registryPath(l),JSON.stringify(registry));
  // Replaced by another directory at the same path: other identity, kept.
  await rename(path,path+'-original');makeTemp(l,'ac-jornal');
  assert.match((await run(l,true)).join('\n'),/ac-jornal: preservado \(o diretório não é o registrado\)/);
  assert.ok(existsSync(join(path,'data.bin')));assert.ok(existsSync(join(path+'-original','data.bin')));
  // Same identity but another birth time than the one journalled: kept.
  await rm(path,{recursive:true});await rename(path+'-original',path);
  registry.temps[0].removing.birth='1';
  await writeFile(registryPath(l),JSON.stringify(registry));
  await rm(join(path,'.ac-retention-owner'));
  assert.match((await run(l,true)).join('\n'),/ac-jornal: preservado \(o diretório não é o que começou a ser removido\)/);
  // No journal and no marker: no proof at all.
  delete registry.temps[0].removing;
  await writeFile(registryPath(l),JSON.stringify(registry));
  assert.match((await run(l,true)).join('\n'),/ac-jornal: preservado \(marca de propriedade ausente\)/);
  assert.ok(existsSync(join(path,'data.bin')));
  // A journal with the right birth but a forged marker still fails on the marker.
  registry.temps[0].removing={since:Date.now(),birth:birthOf(path)};
  await writeFile(registryPath(l),JSON.stringify(registry));
  await writeFile(join(path,'.ac-retention-owner'),JSON.stringify({schemaVersion:1,entryId:id,nonce:'guess'}));
  assert.match((await run(l,true)).join('\n'),/ac-jornal: preservado \(marca de propriedade não confere\)/);
  assert.ok(existsSync(join(path,'data.bin')));
 }finally{await cleanup(l);}
});

test('work/ of jobs is retained first, and a damaged artifact registry never stops it',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'guarded');await register(l,w);
  await writeFile(registryPath(l),'{"schemaVersion":1,"worktrees":[{"path":"/etc"}]}',{mode:0o600});
  const order:string[]=[];
  const jobRetention=async(_config:Installation,apply:boolean)=>{order.push('jobs');return [`jobs apply=${apply}`];};
  const artifactRetention=async(config:Installation,apply:boolean)=>{order.push('artifacts');return runPersonalArtifactRetention(config,apply,l.deps);};
  const verifyDatabaseRetention=async(_config:Installation,apply:boolean)=>{order.push('verify-db');return [`bases apply=${apply}`];};
  for(let pass=0;pass<2;pass++){
   const failure=await runRetentionStages(l.config,true,{jobRetention,verifyDatabaseRetention,artifactRetention}).then(()=>undefined,error=>error);
   assert.ok(failure instanceof RetentionIncomplete);
   assert.deepEqual(failure.failed,['artifacts']);
   assert.equal(failure.lines[0],'jobs apply=true');
   assert.match(failure.lines.join('\n'),/Retenção de artefatos \(worktrees, imagens e temporários\) falhou \(RETENTION_REGISTRY_INVALID\); as demais etapas seguiram\./);
  }
  assert.deepEqual(order,['jobs','verify-db','artifacts','jobs','verify-db','artifacts']);
  assert.ok(existsSync(w.path));
  // The other way round: a failing job stage still lets artifacts run.
  await rm(registryPath(l));
  const failure=await runRetentionStages(l.config,false,{jobRetention:async()=>{throw new Error('database down');},verifyDatabaseRetention,artifactRetention}).then(()=>undefined,error=>error);
  assert.ok(failure instanceof RetentionIncomplete);
  assert.deepEqual(failure.failed,['jobs']);
  assert.match(failure.lines[0]!,/Retenção de work\/ de jobs falhou \(erro\)/);
  assert.match(failure.lines.at(-1)!,/Prévia, nada foi alterado/);
  // Both healthy: plain lines, jobs first.
  assert.deepEqual((await runRetentionStages(l.config,false,{jobRetention,verifyDatabaseRetention,artifactRetention})).slice(0,2),['jobs apply=false','bases apply=false']);
  // A failing vulnerability-database stage still lets artifacts run, and is named in the failure.
  const dbFailure=await runRetentionStages(l.config,false,{jobRetention,verifyDatabaseRetention:async()=>{throw new Refusal('VERIFY_DB_PRUNE_FAILED');},artifactRetention}).then(()=>undefined,error=>error);
  assert.ok(dbFailure instanceof RetentionIncomplete);
  assert.deepEqual(dbFailure.failed,['verify-db']);
  assert.match(dbFailure.lines.join('\n'),/Retenção de bases de vulnerabilidades falhou \(VERIFY_DB_PRUNE_FAILED\); as demais etapas seguiram\./);
  assert.match(dbFailure.lines.at(-1)!,/Prévia, nada foi alterado/);
 }finally{await cleanup(l);}
});

const row=(point:string)=>`99 22 8:2 /x ${point} rw - ext4 /dev/sdb rw\n`;

test('a worktree with a mount or bind mount below it is kept, in preview and apply; escaped names and unreadable mountinfo too',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'mnt');await register(l,w);
  const base='22 1 8:1 / / rw - ext4 /dev/sda1 rw\n';
  for(const text of [base+row(w.path+'/node_modules'),base+row(w.path),base+row(w.path.replace(/wt\/mnt$/,'wt/mnt'))+row(w.path+'/a\\040b'),'','garbage line\n']){
   mountinfo.text=text;
   assert.match((await run(l,false)).join('\n'),/mnt: preservado \((há montagem|não foi possível ler as montagens)/);
   assert.match((await run(l,true)).join('\n'),/mnt: preservado/);
   assert.ok(existsSync(w.path));
  }
  assert.deepEqual(l.calls.filter(a=>a[0]==='worktree'&&(a[1]==='remove'||a[1]==='move')),[]);
  // a sibling with the same prefix, or a mount above, does not count
  mountinfo.text=base+row(w.path+'-other')+row(join(l.base,'wt'));
  assert.match((await run(l,true)).join('\n'),/mnt: removido/);
  assert.equal(existsSync(w.path),false);
 }finally{mountinfo.text='22 1 8:1 / / rw - ext4 /dev/sda1 rw\n';await cleanup(l);}
});

test('a mount that appears after the proof, between isolation and removal, restores the directory and removes nothing',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'race');await register(l,w);
  const racing:RetentionDeps={...l.deps,git:async(cwd,args)=>{
   const result=await l.deps.git!(cwd,args);
   if(args[0]==='worktree'&&args[1]==='move'&&args[2]===w.path)mountinfo.text+=row(args[3]+'/dist');
   return result;
  }};
  const lines=(await runPersonalArtifactRetention(l.config,true,racing)).join('\n');
  assert.match(lines,/race: preservado \(há montagem/);
  assert.ok(existsSync(w.path));
  assert.match(git(l.repo,'worktree','list'),/wt\/race/);
  assert.deepEqual(l.calls.filter(a=>a[0]==='worktree'&&a[1]==='remove'),[]);
 }finally{mountinfo.text='22 1 8:1 / / rw - ext4 /dev/sda1 rw\n';await cleanup(l);}
});

test('a directory swapped for another during isolation is not removed',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'swap');await register(l,w);
  const swapping:RetentionDeps={...l.deps,git:async(cwd,args)=>{
   if(args[0]==='worktree'&&args[1]==='move'&&args[2]===w.path){
    const result=await l.deps.git!(cwd,args);
    // the isolated name is replaced by a symbolic link to somewhere else
    const target=args[3];await rm(target,{recursive:true,force:true});mkdirSync(join(l.base,'elsewhere'));
    const {symlinkSync}=await import('node:fs');symlinkSync(join(l.base,'elsewhere'),target);
    return result;
   }
   return l.deps.git!(cwd,args);
  }};
  const lines=(await runPersonalArtifactRetention(l.config,true,swapping)).join('\n');
  assert.match(lines,/swap: preservado/);
  assert.ok(existsSync(join(l.base,'elsewhere')));
  assert.deepEqual(l.calls.filter(a=>a[0]==='worktree'&&a[1]==='remove'),[]);
 }finally{await cleanup(l);}
});

test('mountinfo parsing: octal escapes decode and prefix siblings are not descendants',()=>{
 assert.deepEqual(mountPoints('1 0 8:1 / /a\\040b rw - ext4 x rw\n'),['/a b']);
 assert.equal(mountedInside(row('/w/x'),'/w'),true);
 assert.equal(mountedInside(row('/w'),'/w'),true);
 assert.equal(mountedInside(row('/wx'),'/w'),false);
 assert.throws(()=>mountPoints(''));
});

type RoundState='terminal'|'running'|'missing';
const withStatus=(l:Lab,state:RoundState|Error,roundId='round-1'):RetentionDeps=>({...l.deps,roundStatus:async(_c,rounds)=>{
 if(state instanceof Error)throw state;
 assert.ok(rounds.every(r=>r.projectId===l.projectId));
 return new Map(rounds.map(r=>[r.projectId+':'+r.roundId,r.roundId===roundId?state:'running' as RoundState]));
}});
const roundsIn=async(l:Lab)=>JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8')).rounds as {roundId:string;endedAt:number}[];

test('a round whose run is terminal in the database but was never closed is closed durably, then ages 24 h before removal',async()=>{
 const l=await lab();
 try{
  const path=makeTemp(l,'ac-retomada-cccc-3');
  await registerTemp(l,path);
  const old=new Date(Date.now()-72*HOUR);await utimes(path,old,old);
  // Preview reports and writes nothing.
  assert.match((await runPersonalArtifactRetention(l.config,false,withStatus(l,'terminal'))).join('\n'),/rodada round-1: encerramento seria registrado/);
  assert.equal((await roundsIn(l)).length,0);
  // Apply closes the round at "now" and still preserves the directory.
  const first=(await runPersonalArtifactRetention(l.config,true,withStatus(l,'terminal'))).join('\n');
  assert.match(first,/encerramento registrado/);
  assert.match(first,/preservado \(rodada encerrada há 0 h/);
  assert.ok(existsSync(path));
  assert.equal((await roundsIn(l)).length,1);
  l.clock.now+=25*HOUR;
  assert.match((await runPersonalArtifactRetention(l.config,true,withStatus(l,'terminal'))).join('\n'),/ac-retomada-cccc-3: removido/);
  assert.equal(existsSync(path),false);
 }finally{await cleanup(l);}
});

test('a round still running, unreadable, or without a run row for less than 7 days is never closed by reconciliation',async()=>{
 const l=await lab();
 try{
  const path=makeTemp(l,'ac-retomada-dddd-4');
  await registerTemp(l,path);
  l.clock.now=Date.now()+30*HOUR;
  for(const state of ['running','missing',new Error('db down')] as const){
   const out=(await runPersonalArtifactRetention(l.config,true,withStatus(l,state))).join('\n');
   assert.match(out,/rodada round-1: sem encerramento registrado, preservada/);
   assert.equal((await roundsIn(l)).length,0);
   assert.ok(existsSync(path));
  }
  assert.match((await runPersonalArtifactRetention(l.config,true,{...l.deps,roundStatus:async()=>new Map()})).join('\n'),/estado desconhecido/);
 }finally{await cleanup(l);}
});

test('a round interrupted before its run row existed is closed only after 7 days, and its temporary then waits 24 h more',async()=>{
 const l=await lab();
 try{
  const path=makeTemp(l,'ac-retomada-eeee-5');
  await registerTemp(l,path);
  const base=Date.now();
  l.clock.now=base+6*24*HOUR;
  assert.match((await runPersonalArtifactRetention(l.config,true,withStatus(l,'missing'))).join('\n'),/sem linha de execução, aguardando 168 h/);
  l.clock.now=base+8*24*HOUR;
  const out=(await runPersonalArtifactRetention(l.config,true,withStatus(l,'missing'))).join('\n');
  assert.match(out,/encerramento registrado \(sem linha de execução\)/);
  assert.ok(existsSync(path));
  l.clock.now+=25*HOUR;
  assert.match((await runPersonalArtifactRetention(l.config,true,withStatus(l,'missing'))).join('\n'),/ac-retomada-eeee-5: removido/);
 }finally{await cleanup(l);}
});

test('worktree mounted by a container is preserved before and after isolation',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'container-mount');await register(l,w);
  l.docker.mounts.set('container',[w.path]);
  assert.match((await run(l,true)).join('\n'),/contêiner com este diretório montado/);
  assert.ok(existsSync(w.path));
  l.docker.mounts.clear();
  const original=l.deps.git!;
  l.deps.git=async(cwd,args)=>{const result=await original(cwd,args);if(args[0]==='worktree'&&args[1]==='move'&&result.code===0)l.docker.mounts.set('container',[args[3]!]);return result;};
  assert.match((await run(l,true)).join('\n'),/contêiner com este diretório montado/);
  assert.ok(existsSync(w.path));
 }finally{await cleanup(l);}
});

test('rejects a base other than the installation checkout branch',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'other-base');git(l.repo,'branch','alternate');
  await assert.rejects(registerWorkerWorktree(l.config,{projectId:l.projectId,...w,base:'alternate'},l.deps));
  await register(l,w);
  const file=join(l.data,'artifact-retention','registry.json');
  const registry=JSON.parse(await readFile(file,'utf8'));registry.worktrees[0].base='alternate';await writeFile(file,JSON.stringify(registry));
  assert.match((await run(l,true)).join('\n'),/base não corresponde/);assert.ok(existsSync(w.path));
 }finally{await cleanup(l);}
});

test('interruption after worktree move leaves a durable reported quarantine',async()=>{
 const l=await lab();
 try{
  const w=makeWorktree(l,'interrupted-move');await register(l,w);const original=l.deps.git!;
  l.deps.git=async(cwd,args)=>{const result=await original(cwd,args);if(args[0]==='worktree'&&args[1]==='move'&&result.code===0)throw Error('crash');return result;};
  await run(l,true);l.deps.git=original;
  const registry=JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8'));
  const quarantine=registry.worktrees[0].quarantine;assert.ok(existsSync(quarantine));
  assert.ok((await run(l,true)).join('\n').includes(quarantine));assert.ok(existsSync(quarantine));
 }finally{await cleanup(l);}
});



// ---- Findings 6a, 6b, 6c: shared daemon pins, transient inspection errors, nominal and effective size ----

const otherInstallation=(l:Lab,name:string,pinned:string[])=>({...l.config,dataDirectory:join(l.base,name),nativeBootstrap:{planning:{imageId:pinned[0]},execution:{workerImage:pinned[1]??pinned[0]}}}) as unknown as Installation;

test('an image pinned by another installation on the same Docker daemon is never removed by this one',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[],size:1_000_000_000});
  await registerOld(l,image('a'));
  const other=otherInstallation(l,'data-b',[image('a')]);
  // B has no container and no registered candidate; its pin is only known through the per-daemon reference registry.
  await runPersonalArtifactRetention(other,false,l.deps);
  const kept=(await run(l,true)).join('\n');
  assert.match(kept,/preservado \(digest fixado por outra instalação neste daemon\)/);
  assert.ok(l.docker.images.has(image('a')));
  assert.deepEqual(removals(l),[]);
  // B stops pinning it and publishes again: only then may A remove it.
  await runPersonalArtifactRetention(otherInstallation(l,'data-b',[image('b')]),false,l.deps);
  assert.match((await run(l,true)).join('\n'),/removida/);
  assert.equal(l.docker.images.has(image('a')),false);
 }finally{await cleanup(l);}
});

test('an unreadable reference file of another installation keeps every candidate',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});
  await registerOld(l,image('a'));
  await run(l,false);
  const {readdirSync,writeFileSync:write}=await import('node:fs');
  const dir=join(l.deps.sharedRefsRoot!,'daemon-test-1');
  assert.equal(readdirSync(dir).filter(name=>name.endsWith('.json')).length,1,'this installation publishes its own pins');
  write(join(dir,'other.json'),'{not json');
  assert.match((await run(l,true)).join('\n'),/preservado \(referências compartilhadas do daemon ilegíveis\)/);
  assert.ok(l.docker.images.has(image('a')));
 }finally{await cleanup(l);}
});

test('a transient inspection failure keeps the image and its registry entry; only an unequivocal answer drops the record',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});
  await registerOld(l,image('a'));
  const registryFile=join(l.data,'artifact-retention','registry.json');
  l.docker.inspectError=true;
  const applied=(await run(l,true)).join('\n');
  assert.match(applied,/preservado \(falha operacional ao inspecionar a imagem\)/);
  assert.doesNotMatch(applied,/registro retirado/);
  assert.equal(JSON.parse(await readFile(registryFile,'utf8')).images.length,1,'the registration survives the failed inspection');
  l.docker.inspectError=false;
  // The daemon says "No such image" but still lists the id: contradiction, so nothing is forgotten.
  const real=l.deps.docker!;
  l.deps.docker=async args=>args[0]==='image'&&args[1]==='inspect'?{code:1,stdout:'',stderr:'Error response from daemon: No such image: x'}:real(args);
  assert.doesNotMatch((await run(l,true)).join('\n'),/registro retirado/);
  assert.equal(JSON.parse(await readFile(registryFile,'utf8')).images.length,1);
  l.deps.docker=real;
  l.docker.images.delete(image('a'));
  assert.match((await run(l,true)).join('\n'),/registro retirado \(a imagem já não existe no Docker\)/);
  assert.equal(JSON.parse(await readFile(registryFile,'utf8')).images.length,0);
 }finally{await cleanup(l);}
});

test('nominal image size and the space actually recovered are reported separately',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[],size:2_500_000_000});
  await registerOld(l,image('a'));
  l.docker.reclaimPerRemoval=400_000_000;
  const preview=(await run(l,false)).join('\n');
  assert.match(preview,/2\.500 GB de tamanho nominal/);
  assert.match(preview,/espaço efetivamente recuperado: não medido \(prévia\)/);
  const applied=(await run(l,true)).join('\n');
  assert.match(applied,/2\.500 GB de tamanho nominal \(camadas compartilhadas podem liberar menos\); espaço efetivamente recuperado: 0\.400 GB/);
 }finally{await cleanup(l);}
});

test('the product registers the runtime images it replaces as candidates',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});
  const id=await registerCandidateImage(l.config,{projectId:l.projectId,module:'native-runtime',imageId:image('a')},l.deps);
  assert.match(id,/^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8')).images[0].module,'native-runtime');
 }finally{await cleanup(l);}
});
