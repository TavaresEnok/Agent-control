import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,realpathSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {chmod,mkdtemp,readFile,rename,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Installation} from '../src/installation.ts';
import {closeRound,registerCandidateImage,registerRoundTemp,registerWorkerWorktree,runPersonalArtifactRetention,
 type CommandResult,type RetentionDeps} from '../src/personal-artifact-retention.ts';

const HOUR=3600_000;
const gitEnv={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',
 GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid'};
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env:gitEnv,encoding:'utf8'}).trim();
const image=(c:string)=>'sha256:'+c.repeat(64);

type Lab={base:string;repo:string;data:string;tmp:string;config:Installation;projectId:string;calls:string[][];dockerCalls:string[][];deps:RetentionDeps;
 clock:{now:number};docker:{images:Map<string,{repoDigests:string[]}>;containers:Set<string>;mounts:Map<string,string[]>;alive:boolean;refuseRemoval:boolean};busy:Set<string>;runImages:string[]|Error};

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
 const docker={images:new Map<string,{repoDigests:string[]}>(),containers:new Set<string>(),mounts:new Map<string,string[]>(),alive:true,refuseRemoval:false};
 const busy=new Set<string>();
 const clock={now:Date.now()+3*HOUR};
 const result:Lab={base,repo,data,tmp,config,projectId,calls,dockerCalls,clock,docker,busy,runImages:[],deps:{},} as Lab;
 result.deps={
  now:()=>clock.now,tmpRoot:tmp,productRoot:join(base,'no-product'),
  git:async(cwd,args):Promise<CommandResult>=>{
   calls.push(args);
   try{return {code:0,stdout:execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,env:{...gitEnv,GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',stdio:['ignore','pipe','ignore']})};}
   catch(error){return {code:(error as {status?:number}).status??1,stdout:''};}
  },
  processInside:async path=>[...busy].some(item=>path===item||path.startsWith(item+'/')),
  verifyRunImages:async()=>{if(result.runImages instanceof Error)throw result.runImages;return result.runImages;},
  docker:async args=>{
   dockerCalls.push(args);
   const [a,b]=args;
   if(a==='version')return {code:docker.alive?0:1,stdout:'27.0\n'};
   if(!docker.alive)return {code:1,stdout:''};
   if(a==='image'&&b==='inspect'){
    const id=args.at(-1)!,found=docker.images.get(id);
    if(!found)return {code:1,stdout:''};
    return {code:0,stdout:args.includes('--format')?id+'\n':JSON.stringify([{Id:id,RepoDigests:found.repoDigests}])};
   }
   if(a==='container'&&b==='ls'&&args.at(-1)==='-q')return {code:0,stdout:[...docker.mounts.keys()].join('\n')+'\n'};
   if(a==='container'&&b==='inspect')return {code:0,stdout:args.slice(4).flatMap(id=>docker.mounts.get(id)??[]).join('\n')+'\n'};
   if(a==='container'&&b==='ls'){
    const id=args.at(-1)!.replace('ancestor=','');
    return {code:0,stdout:docker.containers.has(id)?'abc\n':''};
   }
   if(a==='image'&&b==='rm'){
    if(docker.refuseRemoval)return {code:1,stdout:''};
    docker.images.delete(args.at(-1)!);return {code:0,stdout:''};
   }
   return {code:1,stdout:''};
  },
 };
 return result;
}
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
  assert.match(lines,/ignored: preservado \(há arquivos ignorados que não são regeneráveis\)/);
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

test('an unused, unpinned candidate image is removed by id and nothing else is touched',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});l.docker.images.set(image('b'),{repoDigests:[]});
  await registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('a')},{...l.deps,now:()=>Date.now()});
  assert.match((await run(l,false)).join('\n'),/imagem sha256:aaaaaaaaaaaa \(qa\): elegível/);
  assert.ok(l.docker.images.has(image('a')));
  assert.match((await run(l,true)).join('\n'),/\(qa\): removida/);
  assert.equal(l.docker.images.has(image('a')),false);
  assert.ok(l.docker.images.has(image('b')),'an unregistered image is never touched');
  const removals=l.dockerCalls.filter(args=>args[1]==='rm');
  assert.deepEqual(removals,[['image','rm','--no-prune',image('a')]]);
  assert.equal(l.dockerCalls.some(args=>args.includes('prune')||args.includes('-f')||args.includes('--force')),false);
  const registry=JSON.parse(await readFile(join(l.data,'artifact-retention','registry.json'),'utf8'));
  assert.equal(registry.images.length,0);
 }finally{await cleanup(l);}
});

test('an image stays when pinned by a product or project digest.txt, by the native bootstrap, by a verification run, by a container or when too young',async()=>{
 const l=await lab();
 try{
  const kinds=['1','2','3','4','5','6'];
  for(const k of kinds)l.docker.images.set(image(k),{repoDigests:k==='2'?['registry.example/mod@'+image('9')]:[]});
  for(const k of kinds)await registerCandidateImage(l.config,{projectId:l.projectId,module:'banco',imageId:image(k)},{...l.deps,now:()=>Date.now()-(k==='6'?0:3*HOUR)});
  digestFile(l.deps.productRoot!,'qa',image('1'));
  digestFile(l.repo,'banco','registry.example/mod@'+image('9'));
  (l.config as unknown as {nativeBootstrap:unknown}).nativeBootstrap={qa:{image:image('3')}};
  l.runImages=[image('4')];
  l.docker.containers.add(image('5'));
  l.clock.now=Date.now()+HOUR/2;
  const text=(await run(l,true)).join('\n');
  assert.equal(l.docker.images.size,6);
  assert.match(text,/sha256:111111111111 \(banco\): preservado \(digest fixado ou referenciado por exame\)/);
  assert.match(text,/sha256:222222222222 \(banco\): preservado \(digest fixado/);
  assert.match(text,/sha256:333333333333 \(banco\): preservado \(digest fixado/);
  assert.match(text,/sha256:444444444444 \(banco\): preservado \(digest fixado/);
  assert.match(text,/sha256:555555555555 \(banco\): preservado \(há contêiner|preservado \(registrada há/);
  assert.match(text,/sha256:666666666666 \(banco\): preservado \(registrada há 0 h/);
  // With enough age, only the container still protects image 5.
  l.clock.now=Date.now()+5*HOUR;
  const later=(await run(l,true)).join('\n');
  assert.match(later,/sha256:555555555555 \(banco\): preservado \(há contêiner usando a imagem\)/);
  assert.match(later,/sha256:666666666666 \(banco\): removida/);
  assert.deepEqual([...l.docker.images.keys()].sort(),['1','2','3','4','5'].map(image));
 }finally{await cleanup(l);}
});

test('an unreadable pin or an unreadable verification table keeps every image; Docker down keeps them too; a missing image only loses its record',async()=>{
 const l=await lab();
 try{
  l.docker.images.set(image('a'),{repoDigests:[]});l.docker.images.set(image('b'),{repoDigests:[]});
  await registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('a')},{...l.deps,now:()=>0});
  await registerCandidateImage(l.config,{projectId:l.projectId,module:'qa',imageId:image('b')},{...l.deps,now:()=>0});
  l.runImages=new Error('db down');
  assert.match((await run(l,true)).join('\n'),/preservado \(não foi possível ler os digests fixados e os exames\)/);
  l.runImages=[];
  const mode=join(l.deps.productRoot!,'deploy','modules','qa','digest.txt');
  mkdirSync(mode,{recursive:true});// a directory where the file should be: a read error, not "missing"
  assert.match((await run(l,true)).join('\n'),/não foi possível ler os digests fixados/);
  await rm(l.deps.productRoot!,{recursive:true,force:true});
  l.docker.alive=false;
  assert.match((await run(l,true)).join('\n'),/preservado \(Docker indisponível\)/);
  l.docker.alive=true;
  l.docker.refuseRemoval=true;
  assert.match((await run(l,true)).join('\n'),/o Docker recusou a remoção/);
  assert.equal(l.docker.images.size,2);
  l.docker.refuseRemoval=false;
  l.docker.images.delete(image('b'));
  const text=(await run(l,true)).join('\n');
  assert.match(text,/sha256:bbbbbbbbbbbb \(qa\): registro retirado \(a imagem já não existe no Docker\)/);
  assert.equal(l.docker.images.size,0);
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
   if(args[0]==='worktree'&&args[1]==='remove'&&args.at(-1)===a.path)return {code:1,stdout:''};
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
