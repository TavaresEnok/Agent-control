import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {DockerDependenciesConfig} from '../src/installation.ts';
import {checkPersonalDockerDependencies} from '../src/personal-docker-dependencies.ts';
import {MaintenanceIncomplete,runPersonalMaintenance} from '../src/personal-maintenance.ts';
import {runPersonalWatch} from '../src/personal-watch.ts';

const id='a'.repeat(64);
const container='ac-test-postgres';
const response=(policy:string,status:string,name=container)=>`${id} /${name} ${policy} ${status}\n`;

test('Docker recovery fixes the restart policy and starts a stopped container only when configured',async()=>{
 for(const autoStart of [false,true]){
  const calls:string[][]=[];
  let policy='no',status='exited';
  const checked=await checkPersonalDockerDependencies({containers:[container],autoStart},async args=>{
   calls.push(args);
   if(args[1]==='update')policy='unless-stopped';
   if(args[1]==='start')status='running';
   return response(policy,status);
  });
  assert.deepEqual(calls.map(args=>args[1]),autoStart?['inspect','update','start','inspect']:['inspect','update','inspect']);
  assert.deepEqual(calls[1],['container','update','--restart','unless-stopped',id]);
  if(autoStart)assert.deepEqual(calls[2],['container','start',id]);
  assert.equal(checked.failed,!autoStart);
  assert.match(checked.notices[0]!.text,autoStart?/início automático/:/fora do ar/);
 }
});

test('Docker recovery confirms the change, scopes commands to exact names and continues after inspection failure',async()=>{
 assert.equal(DockerDependenciesConfig.safeParse({containers:['--help']}).success,false);
 const calls:string[][]=[];
 const checked=await checkPersonalDockerDependencies({containers:['missing','mismatched',container],autoStart:true},async args=>{
  calls.push(args);
  if(args.at(-1)==='missing')throw Error('Docker unavailable');
  if(args.at(-1)==='mismatched')return response('no','running','other');
  return response('unless-stopped','running');
 });
 assert(checked.failed);
 assert.equal(checked.notices.length,2);
 assert.equal(checked.lines.length,3);
 assert(calls.every(args=>args[1]==='inspect'));
 const unconfirmed=await checkPersonalDockerDependencies({containers:[container],autoStart:true},async()=>response('no','running'));
 assert(unconfirmed.failed);
 const restarting=await checkPersonalDockerDependencies({containers:[container],autoStart:true},async args=>{
  assert.equal(args[1],'inspect');
  return response('unless-stopped','restarting');
 });
 assert(restarting.failed);
});

async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'personal-docker-deps-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'installation.json');
 await writeFile(file,JSON.stringify({
  schemaVersion:1,mode:'administration-only',activation:'personal',
  databaseUrl:'postgresql://postgres@127.0.0.1:1/disposable',dataDirectory:root,
  project:{id:randomUUID(),label:'Test',repo:join(root,'repo'),owner:'test'},
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
  dockerDependencies:{containers:[container]},
 }),{mode:0o600});
 return file;
}

test('watch alerts on an unavailable dependency before any rebuild and maintenance reports the same failure',async t=>{
 const file=await fixture(t);
 let checks=0,notifications=0;
 const dockerDependencies:typeof checkPersonalDockerDependencies=async config=>{
  assert.deepEqual(config,{containers:[container],autoStart:false});
  checks++;
  return checkPersonalDockerDependencies(config,async()=>response('unless-stopped','exited'));
 };
 const status=await runPersonalWatch([file],{
  dockerDependencies,images:()=>['sha256:'+id],inspectImage:async()=>{throw Error('unexpected image inspection');},
  diskUsedPercent:async()=>20,logins:async()=>[],recentLog:async()=>'',retention:async()=>{},
  probe:async()=>{assert.equal(checks,1);return true;},
  notify:async(_dir,body)=>{assert.match(body,/ac-test-postgres.*fora do ar/);notifications++;},
 });
 assert.equal(notifications,1);
 assert.match(status,/images=skipped docker=failed notice=docker$/);
 await assert.rejects(runPersonalMaintenance([file,'--dependencias-docker'],{dockerDependencies}),
  (error:unknown)=>error instanceof MaintenanceIncomplete&&error.failed[0]==='docker'&&error.lines[0]!.includes(container));
 const refreshDatabases=async()=>{};
 const currentDatabase=async()=>null;
 const docker=async()=>1;
 await assert.rejects(runPersonalMaintenance([file],{dockerDependencies,refreshDatabases,currentDatabase,docker}),
  (error:unknown)=>error instanceof MaintenanceIncomplete&&error.failed[0]==='docker');
 assert.equal(checks,3);
});
