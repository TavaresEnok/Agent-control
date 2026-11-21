import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {MaintenanceIncomplete,RetentionIncomplete,runPersonalMaintenance} from '../src/personal-maintenance.ts';
import {personalTimerUnits} from '../src/personal-timers.ts';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {retiredPlan} from '../src/personal-maintenance.ts';
import {newestBackup} from '../src/personal-restore-proof.ts';

const image=(c:string)=>'sha256:'+c.repeat(64);

test('a retired image leaves only when no job needs it and nothing current uses it',()=>{
 const boot={planning:{imageId:image('a'),retiredImageIds:[image('b'),image('c')]},
  execution:{workerImage:image('d'),toolsImage:image('e'),retiredImages:[{workerImage:image('f'),toolsImage:image('e')},{workerImage:image('1'),toolsImage:image('2')}]},qa:{image:image('e')}};
 const open=new Map([[nativeExecutionExecutorDigest(image('f'),image('e')),0],[nativeExecutionExecutorDigest(image('1'),image('2')),3]]);
 const plan=retiredPlan(boot,open,0);
 assert.deepEqual(plan.dropPairs,[{workerImage:image('f'),toolsImage:image('e')}]);
 assert.deepEqual(plan.keepPairs,[{workerImage:image('1'),toolsImage:image('2')}]);
 assert.deepEqual(plan.dropPlanning,[image('b'),image('c')]);
 // The shared tools image is still current, so only the old worker goes.
 assert.deepEqual(plan.removable.sort(),[image('b'),image('c'),image('f')].sort());
 const busy=retiredPlan(boot,new Map(),2);
 assert.deepEqual(busy.dropPairs,[]);assert.deepEqual(busy.dropPlanning,[]);assert.deepEqual(busy.removable,[]);
});

test('the restore proof picks the newest dated backup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'restore-proof-'));
 try{
  for(const day of ['20261114-033007','20261116-033007','20261115-033007']){
   await mkdir(join(root,day,`agent-control-ispagent-${day.slice(0,13)}`),{recursive:true});
  }
  await mkdir(join(root,'not-a-backup'));await writeFile(join(root,'20991231-000000'),'file');
  assert.equal(await newestBackup(root),join(root,'20261116-033007','agent-control-ispagent-20261116-0330'));
 }finally{await rm(root,{recursive:true,force:true});}
});


test('scheduled retention reads the current switch for each run',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scheduled-retention-'));
 try{
  const file=join(root,'installation.json');
  const repo=join(root,'repo');await mkdir(repo);
  const body:any={schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:'postgresql://x:x@localhost/db',dataDirectory:root,project:{id:randomUUID(),label:'test',repo,owner:'test'},projects:[],http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://localhost:8765'}};
  const observed:boolean[]=[];const deps={jobRetention:async(_config:any,apply:boolean)=>{observed.push(apply);return [];},artifactRetention:async()=>[]};
  for(const automatic of [undefined,'off','preview','apply']){if(automatic)body.retention={automatic};await writeFile(file,JSON.stringify(body),{mode:0o600});await runPersonalMaintenance([file,'--retencao-agendada'],deps);}
  assert.deepEqual(observed,[false,false,true]);
 }finally{await rm(root,{recursive:true,force:true});}
});


// ---- Scheduled maintenance: databases, retention and dedicated cache are separate stages ----

async function scheduledFixture(automatic?:'off'|'preview'|'apply'){
 const base=await mkdtemp(join(tmpdir(),'scheduled-maintenance-'));
 const directory=join(base,'ispagent'),repo=join(base,'repo');
 await mkdir(directory,{recursive:true,mode:0o700});await mkdir(repo);
 const file=join(directory,'installation.json');
 const body:any={schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:'postgresql://x:x@localhost/db',dataDirectory:directory,project:{id:randomUUID(),label:'test',repo,owner:'test'},projects:[],http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://localhost:8765'}};
 if(automatic)body.retention={automatic};
 await writeFile(file,JSON.stringify(body),{mode:0o600});
 return {base,directory,file};
}
function recorder(options:{dedicatedBuilder?:boolean;refreshFails?:boolean;retentionFails?:boolean;fetchedAt?:string|null}={}){
 const seen={refresh:0,retention:[] as boolean[],docker:[] as string[][]};
 const deps={
  refreshDatabases:async()=>{seen.refresh++;if(options.refreshFails)throw new Error('offline');},
  jobRetention:async(_c:unknown,apply:boolean)=>{seen.retention.push(apply);if(options.retentionFails)throw new Error('db down');return [apply?'jobs apagados':'jobs em prévia'];},
  artifactRetention:async()=>['artefatos ok'],
  docker:async(args:string[])=>{seen.docker.push(args);return args[0]==='buildx'&&args[1]==='inspect'&&!options.dedicatedBuilder?1:0;},
  currentDatabase:async()=>options.fetchedAt===null?null:{fetchedAt:options.fetchedAt??'2026-11-17T04:00:00.000Z'},
  now:()=>new Date('2026-11-20T04:00:00.000Z'),
 };
 return {seen,deps};
}
/** The exact command line that the installed weekly service runs, split into its arguments. */
function installedMaintenanceArgs(file:string){
 const root=fileURLToPath(new URL('..',import.meta.url));
 const plan=personalTimerUnits({name:'ispagent',root,installationFile:file,execPath:'/usr/bin/node'});
 const service=plan.units.find(unit=>unit.file==='agent-control-maintenance-ispagent.service')!;
 const exec=service.text.split('\n').find(line=>line.startsWith('ExecStart='))!.slice('ExecStart='.length).split(' ');
 assert.equal(exec[0],'/usr/bin/node');
 assert.equal(exec[1],join(root,'scripts/personal-maintenance.mjs'));
 return exec.slice(2);
}

test('the weekly service command updates the databases, runs retention in the configured mode and reports last run, last success, age and mode',async()=>{
 const env=await scheduledFixture('apply');
 try{
  const r=recorder();
  const lines=await runPersonalMaintenance(installedMaintenanceArgs(env.file),r.deps);
  const text=lines.join('\n');
  assert.equal(r.seen.refresh,1,'the weekly command refreshes the vulnerability databases');
  assert.deepEqual(r.seen.retention,[true],'retention runs in the configured mode');
  assert.match(text,/Bases de vulnerabilidade atualizadas/);
  assert.match(text,/Bases: última execução 2026-11-20T04:00:00\.000Z, último sucesso 2026-11-20T04:00:00\.000Z, idade da base publicada 3 dia\(s\)/);
  assert.match(text,/Retenção: modo apply, última execução 2026-11-20T04:00:00\.000Z, último sucesso 2026-11-20T04:00:00\.000Z/);
  assert.match(text,/Cache de build dedicado: sem builder dedicado desta instalação; o cache do daemon não foi tocado/);
  assert.equal(r.seen.docker.some(args=>args.includes('prune')),false,'no builder dedicated to the installation, no cache command at all');
  const saved=JSON.parse(await readFile(join(env.directory,'maintenance-status.json'),'utf8'));
  assert.equal(saved.stages.bases.lastSuccess,'2026-11-20T04:00:00.000Z');
  assert.equal(saved.stages.retention.lastSuccess,'2026-11-20T04:00:00.000Z');
 }finally{await rm(env.base,{recursive:true,force:true});}
});

test('preview mode is shown as such and off mode skips only retention; the databases still update',async()=>{
 for(const mode of ['preview','off'] as const){
  const env=await scheduledFixture(mode);
  try{
   const r=recorder();
   const text=(await runPersonalMaintenance(installedMaintenanceArgs(env.file),r.deps)).join('\n');
   assert.equal(r.seen.refresh,1,mode);
   assert.match(text,new RegExp(`Retenção: modo ${mode}`));
   if(mode==='preview'){assert.deepEqual(r.seen.retention,[false]);assert.match(text,/prévia: nada é apagado/);}
   else assert.deepEqual(r.seen.retention,[]);
  }finally{await rm(env.base,{recursive:true,force:true});}
 }
});

test('a failed stage never stops the others; the run fails after all ran and last success is kept per stage',async()=>{
 const env=await scheduledFixture('apply');
 try{
  const failing=recorder({refreshFails:true});
  await assert.rejects(runPersonalMaintenance(installedMaintenanceArgs(env.file),failing.deps),(error:unknown)=>{
   assert.ok(error instanceof MaintenanceIncomplete&&error instanceof RetentionIncomplete);
   assert.deepEqual((error as MaintenanceIncomplete).failed,['bases']);
   assert.match((error as MaintenanceIncomplete).lines.join('\n'),/Bases de vulnerabilidade não atualizadas/);
   return true;
  });
  assert.deepEqual(failing.seen.retention,[true],'retention ran although the databases failed');
  const status=JSON.parse(await readFile(join(env.directory,'maintenance-status.json'),'utf8'));
  assert.equal(status.stages.bases.lastSuccess,undefined);
  assert.equal(status.stages.bases.outcome,'failed');
  assert.equal(status.stages.retention.outcome,'ok');
  // Next week the databases work again; retention fails this time. The earlier success of each stage is not erased.
  const later=recorder({retentionFails:true});
  later.deps.now=()=>new Date('2026-11-27T04:00:00.000Z');
  await assert.rejects(runPersonalMaintenance(installedMaintenanceArgs(env.file),later.deps),(error:unknown)=>error instanceof MaintenanceIncomplete&&(error as MaintenanceIncomplete).failed.join()==='retention');
  const after=JSON.parse(await readFile(join(env.directory,'maintenance-status.json'),'utf8'));
  assert.equal(after.stages.bases.lastSuccess,'2026-11-27T04:00:00.000Z');
  assert.equal(after.stages.retention.lastSuccess,'2026-11-20T04:00:00.000Z');
  assert.equal(after.stages.retention.lastRun,'2026-11-27T04:00:00.000Z');
 }finally{await rm(env.base,{recursive:true,force:true});}
});

test('the status command shows the stored state without running any stage',async()=>{
 const env=await scheduledFixture('apply');
 try{
  await runPersonalMaintenance(installedMaintenanceArgs(env.file),recorder().deps);
  const r=recorder({fetchedAt:'2026-10-01T04:00:00.000Z'});
  const text=(await runPersonalMaintenance([env.file,'--estado-manutencao'],r.deps)).join('\n');
  assert.equal(r.seen.refresh,0);assert.deepEqual(r.seen.retention,[]);assert.deepEqual(r.seen.docker,[]);
  assert.match(text,/idade da base publicada 50 dia\(s\)/);
  assert.match(text,/ATENÇÃO: base de vulnerabilidades com mais de 14 dias/);
  assert.match(text,/Retenção: modo apply, última execução 2026-11-20/);
 }finally{await rm(env.base,{recursive:true,force:true});}
});

test('cache is cleaned only on a builder dedicated to the installation, never on the shared daemon',async()=>{
 const env=await scheduledFixture('apply');
 try{
  const r=recorder({dedicatedBuilder:true});
  const text=(await runPersonalMaintenance(installedMaintenanceArgs(env.file),r.deps)).join('\n');
  assert.deepEqual(r.seen.docker,[['buildx','inspect','agent-control-ispagent'],['buildx','prune','--builder','agent-control-ispagent','-f','--filter','until=168h']]);
  assert.match(text,/Cache de build dedicado: cache com mais de 7 dias apagado no builder agent-control-ispagent/);
  // The manual run (no flag) follows the same rule and no longer prunes the daemon.
  const manual=recorder();
  await runPersonalMaintenance([env.file],manual.deps);
  assert.equal(manual.seen.docker.some(args=>args[0]==='builder'||args.includes('prune')),false);
 }finally{await rm(env.base,{recursive:true,force:true});}
});
