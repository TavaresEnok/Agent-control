import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import type {Installation} from '../src/installation.ts';
import {ARTIFACT_COMMANDS,ARTIFACT_USAGE,artifactCliMessages,isArtifactCommand,runArtifactCommand} from '../src/personal-artifact-commands.ts';
import type {CommandResult,RetentionDeps} from '../src/personal-artifact-retention.ts';

/**
 * The real dispatcher `runArtifactCommand` against the real registry and the real retention run, with a real git
 * repository and real temporary folders. Only Docker and the process scan are replaced. Nothing outside the lab is touched.
 */

const HOUR=3600_000;
const gitEnv={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',
 GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid'};
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env:gitEnv,encoding:'utf8'}).trim();
const realGit=(cwd:string,args:string[])=>new Promise<CommandResult>(done=>{
 execFile('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env:gitEnv,encoding:'utf8'},(error,stdout)=>done({code:error?(typeof (error as {code?:unknown}).code==='number'?(error as unknown as {code:number}).code:1):0,stdout:stdout??''}));
});
const IMAGE='sha256:'+'c1'.repeat(32);
const PINNED='sha256:'+'d2'.repeat(32);

type Lab={base:string;repo:string;data:string;tmp:string;product:string;projectId:string;config:Installation;removed:string[][];deps:(now?:number)=>RetentionDeps};
async function lab(activation:'personal'|'other'='personal'):Promise<Lab>{
 const base=realpathSync(await mkdtemp(join(tmpdir(),'artifact-commands-')));
 const repo=join(base,'repo'),data=join(base,'data'),tmp=join(base,'tmp'),product=join(base,'product');
 mkdirSync(repo);mkdirSync(data,{mode:0o700});mkdirSync(tmp,{mode:0o700});mkdirSync(product);
 git(repo,'init','-q','-b','main');
 writeFileSync(join(repo,'a.txt'),'a\n');git(repo,'add','.');git(repo,'commit','-q','-m','first');
 const projectId=randomUUID();
 const config={activation,dataDirectory:data,databaseUrl:'postgres://invalid.example/none',project:{id:projectId,label:'p',repo,owner:'owner'},projects:[]} as unknown as Installation;
 const removed:string[][]=[],gone=new Set<string>();
 const docker=async(args:string[])=>{
  if(args[0]==='info')return {code:0,stdout:'daemon-test-1'};
  if(args[0]==='image'&&args[1]==='inspect'){
   const id=args.at(-1)!;
   if((id!==IMAGE&&id!==PINNED)||gone.has(id))return {code:1,stdout:''};
   return args.includes('--format')?{code:0,stdout:id+'\n'}:{code:0,stdout:JSON.stringify([{Id:id,RepoDigests:[]}])};
  }
  if(args[0]==='image'&&args[1]==='rm'){removed.push(args);gone.add(args[2]!);return {code:0,stdout:''};}
  if(args[0]==='version')return {code:0,stdout:'x'};
  return {code:0,stdout:''};
 };
 return {base,repo,data,tmp,product,projectId,config,removed,
  deps:(now=Date.now())=>({git:realGit,docker,now:()=>now,tmpRoot:tmp,productRoot:product,sharedRefsRoot:join(base,'shared-refs'),freeBytes:async()=>undefined,processInside:async()=>false,verifyRunImages:async()=>[]})};
}
const done=(l:Lab)=>rm(l.base,{recursive:true,force:true});
const registryFile=(l:Lab)=>join(l.data,'artifact-retention','registry.json');
const refusal=(code:string)=>(error:unknown)=>{assert.ok(error instanceof Refusal,String(error));assert.equal((error as Refusal).code,code);return true;};

test('isArtifactCommand recognises exactly the five commands, and the usage text names each of them',()=>{
 for(const command of ARTIFACT_COMMANDS){assert.equal(isArtifactCommand([command]),true);assert.ok(ARTIFACT_USAGE.includes(command));}
 assert.equal(isArtifactCommand([]),false);
 assert.equal(isArtifactCommand(['--liberar-work-exames']),false);
 assert.equal(isArtifactCommand(['--abandonar-design','x']),false);
 assert.equal(isArtifactCommand(['registrar']),false);
});

test('every refusal the registry can raise has a message for the owner',()=>{
 for(const code of ['RETENTION_PROJECT_UNKNOWN','RETENTION_REGISTRATION_INVALID','RETENTION_REGISTRATION_CONFLICT','RETENTION_REGISTRY_INVALID','RETENTION_REGISTRY_BUSY'])
  assert.ok(artifactCliMessages[code]?.length>20,code);
});

test('malformed arguments are a usage error and nothing is read or written',async()=>{
 const l=await lab();
 try{
  const id=l.projectId;
  const bad:string[][]=[
   [],['--registrar-worktree'],
   ['--registrar-worktree','--projeto',id,'--caminho',l.repo,'--ramo','x'],
   ['--registrar-worktree','--projeto',id,'--caminho','relative/path','--ramo','x','--base','main'],
   ['--registrar-worktree','--projeto','not-a-uuid','--caminho',l.repo,'--ramo','x','--base','main'],
   ['--registrar-worktree','--projeto',id,'--caminho',l.repo,'--ramo','--base','--base','main'],
   ['--registrar-worktree','--projeto',id,'--projeto',id,'--caminho',l.repo,'--ramo','x','--base','main'],
   ['--registrar-worktree','--projeto',id,'--caminho',l.repo,'--ramo','x','--base','main','--forcar'],
   ['--registrar-worktree','--projeto',id,'--caminho',l.repo,'--ramo','-x','--base','main'],
   ['--registrar-imagem','--projeto',id,'--modulo','qa','--imagem','latest'],
   ['--registrar-imagem','--projeto',id,'--modulo','nao-existe','--imagem',IMAGE],
   ['--registrar-temporario','--projeto',id,'--rodada','../x','--caminho',join(l.tmp,'ac-x')],
   ['--registrar-temporario','--projeto',id,'--rodada','r1','--caminho','tmp/ac-x'],
   ['--encerrar-rodada','--projeto',id],
   ['--encerrar-rodada','--projeto',id,'--rodada','r1','extra'],
   ['--retencao-artefatos','--aplicar','--aplicar'],
   ['--retencao-artefatos','--projeto',id],
   ['--retencao-artefatos','--aplicar','sim'],
  ];
  for(const args of bad)await assert.rejects(runArtifactCommand(l.config,args,l.deps()),refusal('MAINTENANCE_USAGE'),JSON.stringify(args));
  assert.equal(existsSync(join(l.data,'artifact-retention')),false);
 }finally{await done(l);}
});

test('an installation that is not personal is refused, and not even a registry directory appears',async()=>{
 const l=await lab('other');
 try{
  await assert.rejects(runArtifactCommand(l.config,['--encerrar-rodada','--projeto',l.projectId,'--rodada','r1'],l.deps()),refusal('MAINTENANCE_PERSONAL_REQUIRED'));
  await assert.rejects(runArtifactCommand(l.config,['--retencao-artefatos'],l.deps()),refusal('MAINTENANCE_PERSONAL_REQUIRED'));
  assert.equal(existsSync(join(l.data,'artifact-retention')),false);
 }finally{await done(l);}
});

test('a project outside the installation is refused',async()=>{
 const l=await lab();
 try{
  await assert.rejects(runArtifactCommand(l.config,['--encerrar-rodada','--projeto',randomUUID(),'--rodada','r1'],l.deps()),refusal('RETENTION_PROJECT_UNKNOWN'));
  await assert.rejects(runArtifactCommand(l.config,['--registrar-imagem','--projeto',randomUUID(),'--modulo','qa','--imagem',IMAGE],l.deps()),refusal('RETENTION_PROJECT_UNKNOWN'));
 }finally{await done(l);}
});

test('a supervised worker worktree is registered, kept until its branch is integrated, clean and idle, then removed with its branch kept',async()=>{
 const l=await lab();
 try{
  const path=join(l.base,'wt-worker');
  git(l.repo,'worktree','add','-q','-b','task/worker',path);
  writeFileSync(join(path,'b.txt'),'b\n');git(path,'add','.');git(path,'commit','-q','-m','work');
  const args=['--registrar-worktree','--projeto',l.projectId,'--caminho',path,'--ramo','task/worker','--base','main'];
  const first=await runArtifactCommand(l.config,args,l.deps());
  assert.match(first[0]!,/registrado \(novo; ramo task\/worker, integração em main\)/);
  // Registering the same thing again is the same registration; a different base is a conflict.
  await runArtifactCommand(l.config,args,l.deps());
  assert.equal(JSON.parse(readFileSync(registryFile(l),'utf8')).worktrees.length,1);
  await assert.rejects(runArtifactCommand(l.config,[...args.slice(0,-1),'task/other'],l.deps()),refusal('RETENTION_REGISTRATION_INVALID'));
  git(l.repo,'branch','task/other');
  await assert.rejects(runArtifactCommand(l.config,[...args.slice(0,-1),'task/other'],l.deps()),refusal('RETENTION_REGISTRATION_INVALID'));

  const later=Date.now()+30*HOUR;
  const before=readFileSync(registryFile(l),'utf8');
  assert.match((await runArtifactCommand(l.config,['--retencao-artefatos'],l.deps(later))).join('\n'),/ramo ainda não integrado em main/);
  assert.equal(readFileSync(registryFile(l),'utf8'),before,'the preview changes nothing, not even the registry');
  assert.ok(existsSync(path));

  git(l.repo,'merge','-q','--ff-only','task/worker');
  const preview=(await runArtifactCommand(l.config,['--retencao-artefatos'],l.deps(later))).join('\n');
  assert.match(preview,/elegível \(ramo task\/worker integrado em main/);
  assert.ok(existsSync(path),'the preview removes nothing');
  // Too recent: the idle fence holds even for an integrated branch.
  assert.match((await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(Date.now()))).join('\n'),/atividade há 0 h \(mínimo 2 h\)/);
  assert.ok(existsSync(path));
  // Uncommitted work keeps it.
  writeFileSync(join(path,'wip.txt'),'wip\n');
  assert.match((await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(later))).join('\n'),/há mudanças ou arquivos não rastreados/);
  assert.ok(existsSync(path));
  await rm(join(path,'wip.txt'));
  const applied=(await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(later))).join('\n');
  assert.match(applied,/removido \(ramo task\/worker preservado\)/);
  assert.equal(existsSync(path),false);
  assert.equal(git(l.repo,'rev-parse','--verify','refs/heads/task/worker'),git(l.repo,'rev-parse','HEAD'));
  assert.equal(JSON.parse(readFileSync(registryFile(l),'utf8')).worktrees.length,0);
 }finally{await done(l);}
});

test('the main worktree, a directory git does not know, and a branch the worktree is not on cannot be registered',async()=>{
 const l=await lab();
 try{
  const path=join(l.base,'wt-x');
  git(l.repo,'worktree','add','-q','-b','task/x',path);
  const common=['--projeto',l.projectId];
  await assert.rejects(runArtifactCommand(l.config,['--registrar-worktree',...common,'--caminho',l.repo,'--ramo','main','--base','task/x'],l.deps()),refusal('RETENTION_REGISTRATION_INVALID'));
  await assert.rejects(runArtifactCommand(l.config,['--registrar-worktree',...common,'--caminho',l.tmp,'--ramo','task/x','--base','main'],l.deps()),refusal('RETENTION_REGISTRATION_INVALID'));
  await assert.rejects(runArtifactCommand(l.config,['--registrar-worktree',...common,'--caminho',path,'--ramo','main','--base','task/x'],l.deps()),refusal('RETENTION_REGISTRATION_INVALID'));
  await assert.rejects(runArtifactCommand(l.config,['--registrar-worktree',...common,'--caminho',path,'--ramo','task/x','--base','task/x'],l.deps()),refusal('RETENTION_REGISTRATION_INVALID'));
  await assert.rejects(runArtifactCommand(l.config,['--registrar-worktree',...common,'--caminho',path,'--ramo','task/x','--base','sem-ramo'],l.deps()),refusal('RETENTION_REGISTRATION_INVALID'));
  assert.equal(existsSync(registryFile(l)),false);
  // An already existing worktree can be adopted explicitly.
  const adopted=await runArtifactCommand(l.config,['--registrar-worktree',...common,'--caminho',path,'--ramo','task/x','--base','main','--adotar'],l.deps());
  assert.match(adopted[0]!,/existente adotado/);
 }finally{await done(l);}
});

test('a candidate image is registered only when it exists locally, and a pinned digest is never removed',async()=>{
 const l=await lab();
 try{
  await assert.rejects(runArtifactCommand(l.config,['--registrar-imagem','--projeto',l.projectId,'--modulo','qa','--imagem','sha256:'+'00'.repeat(32)],l.deps()),refusal('RETENTION_REGISTRATION_INVALID'));
  assert.equal(existsSync(registryFile(l)),false);
  const out=await runArtifactCommand(l.config,['--registrar-imagem','--projeto',l.projectId,'--modulo','qa','--imagem',IMAGE],l.deps());
  assert.match(out[0]!,/Imagem candidata sha256:c1c1c1c1c1c1 \(qa\) registrada/);
  await runArtifactCommand(l.config,['--registrar-imagem','--projeto',l.projectId,'--modulo','qa','--imagem',PINNED],l.deps());
  await assert.rejects(runArtifactCommand(l.config,['--registrar-imagem','--projeto',l.projectId,'--modulo','banco','--imagem',IMAGE],l.deps()),refusal('RETENTION_REGISTRATION_CONFLICT'));
  mkdirSync(join(l.product,'deploy','modules','qa'),{recursive:true});
  writeFileSync(join(l.product,'deploy','modules','qa','digest.txt'),PINNED+'\n');
  const later=Date.now()+30*HOUR;
  const preview=(await runArtifactCommand(l.config,['--retencao-artefatos'],l.deps(later))).join('\n');
  assert.match(preview,/imagem sha256:c1c1c1c1c1c1 \(qa\): elegível/);
  assert.match(preview,/imagem sha256:d2d2d2d2d2d2 \(qa\): preservado \(digest fixado/);
  assert.deepEqual(l.removed,[]);
  // Too recent to remove.
  assert.match((await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(Date.now()))).join('\n'),/registrada há 0 h \(mínimo 24 h\)/);
  await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(later));
  assert.deepEqual(l.removed,[['image','rm',IMAGE]],'only the unpinned candidate goes, by id');
 }finally{await done(l);}
});

test('a round folder opened from outside is kept until the round is ended and 24 h have passed',async()=>{
 const l=await lab();
 try{
  const folder=join(l.tmp,'ac-lote-externo');
  mkdirSync(folder,{mode:0o700});writeFileSync(join(folder,'saida.log'),'x\n');
  const register=['--registrar-temporario','--projeto',l.projectId,'--rodada','lote-1','--caminho',folder];
  assert.match((await runArtifactCommand(l.config,register,l.deps()))[0]!,/registrado na rodada lote-1/);
  await runArtifactCommand(l.config,register,l.deps());
  assert.equal(JSON.parse(readFileSync(registryFile(l),'utf8')).temps.length,1);
  await assert.rejects(runArtifactCommand(l.config,[...register.slice(0,4),'outra',...register.slice(5)],l.deps()),refusal('RETENTION_REGISTRATION_CONFLICT'));
  const t0=Date.now();
  assert.match((await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(t0+100*HOUR))).join('\n'),/rodada sem prova de encerramento/);
  assert.ok(existsSync(folder));
  assert.match((await runArtifactCommand(l.config,['--encerrar-rodada','--projeto',l.projectId,'--rodada','lote-1'],l.deps(t0)))[0]!,/Rodada lote-1 encerrada/);
  // Ending twice keeps the first end time.
  await runArtifactCommand(l.config,['--encerrar-rodada','--projeto',l.projectId,'--rodada','lote-1'],l.deps(t0+50*HOUR));
  assert.match((await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(t0+23*HOUR))).join('\n'),/rodada encerrada há 23 h \(mínimo 24 h\)/);
  assert.ok(existsSync(folder));
  assert.match((await runArtifactCommand(l.config,['--retencao-artefatos'],l.deps(t0+25*HOUR))).join('\n'),/elegível \(rodada lote-1 encerrada há 25 h\)/);
  assert.ok(existsSync(folder));
  assert.match((await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(t0+25*HOUR))).join('\n'),/removido\./);
  assert.equal(existsSync(folder),false);
 }finally{await done(l);}
});

test('a temporary that is a link, outside the temporary root, not named ac-*, or not a directory cannot be registered',async()=>{
 const l=await lab();
 try{
  const real=join(l.tmp,'ac-real');mkdirSync(real,{mode:0o700});
  symlinkSync(real,join(l.tmp,'ac-link'));
  mkdirSync(join(l.base,'elsewhere'),{mode:0o700});
  mkdirSync(join(l.tmp,'other-name'),{mode:0o700});
  writeFileSync(join(l.tmp,'ac-file'),'x');
  for(const path of [join(l.tmp,'ac-link'),join(l.base,'elsewhere'),join(l.tmp,'other-name'),join(l.tmp,'ac-file'),join(l.tmp,'ac-missing'),l.tmp,join(real,'..','ac-real','..')]){
   await assert.rejects(runArtifactCommand(l.config,['--registrar-temporario','--projeto',l.projectId,'--rodada','r','--caminho',path],l.deps()),
    error=>error instanceof Refusal&&['RETENTION_REGISTRATION_INVALID','MAINTENANCE_USAGE'].includes(error.code),path);
  }
  assert.equal(existsSync(join(real,'.ac-retention-owner')),false);
  assert.equal(existsSync(registryFile(l)),false);
 }finally{await done(l);}
});

test('items named ac-* without a registry proof are counted and never touched',async()=>{
 const l=await lab();
 try{
  mkdirSync(join(l.tmp,'ac-stranger'),{mode:0o700});
  const lines=(await runArtifactCommand(l.config,['--retencao-artefatos','--aplicar'],l.deps(Date.now()+1000*HOUR))).join('\n');
  assert.match(lines,/1 item\(ns\) ac-\* no diretório temporário sem registro de propriedade: preservado/);
  assert.ok(existsSync(join(l.tmp,'ac-stranger')));
 }finally{await done(l);}
});

test('the runtime images that personal:images replaces are registered with their own kind',async()=>{
 const l=await lab();
 try{
  const out=await runArtifactCommand(l.config,['--registrar-imagem','--projeto',l.projectId,'--modulo','native-runtime','--imagem',IMAGE],l.deps());
  assert.match(out[0]!,/Imagem candidata sha256:c1c1c1c1c1c1 \(native-runtime\) registrada/);
  await assert.rejects(runArtifactCommand(l.config,['--registrar-imagem','--projeto',l.projectId,'--modulo','runtime','--imagem',IMAGE],l.deps()),refusal('MAINTENANCE_USAGE'));
 }finally{await done(l);}
});
