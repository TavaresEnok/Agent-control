import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {runPersonalTimers} from '../src/personal-timers.ts';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'personal-timers-'));
 const data=join(root,'ispagent'),repo=join(root,'repo'),home=join(root,'home'),id=randomUUID();
 await mkdir(data,{recursive:true,mode:0o700});
 await mkdir(repo,{recursive:true});
 const file=join(data,'installation.json');
 const body={schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:'postgresql://ac:s3cret@127.0.0.1:54329/agent_control',dataDirectory:data,
  accountHomesDirectory:join(data,'accounts'),
  project:{id,label:'IspAgent',repo,owner:'owner@example.com'},projects:[],
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'}};
 await writeFile(file,JSON.stringify(body)+'\n',{mode:0o600});
 await chmod(file,0o600);
 return {root,data,file,home};
}

test('timer units schedule the watch every two minutes and the backup at 03:30',async()=>{
 const env=await fixture();
 const calls:string[][]=[];
 const root=fileURLToPath(new URL('..',import.meta.url));
 try{
  const line=await runPersonalTimers([env.file],{home:env.home,root,execPath:'/usr/bin/node',systemctl:args=>{calls.push(args);}});
  assert.equal(line.includes('s3cret'),false);
  assert.equal(line.includes('postgresql'),false);
  const parsed=JSON.parse(line) as {installed:string[];backupDirectory:string};
  assert.deepEqual(parsed.installed,['agent-control-watch-ispagent.timer', 'agent-control-backup-ispagent.timer', 'agent-control-maintenance-ispagent.timer', 'agent-control-restore-proof-ispagent.timer']);
  assert.equal(parsed.backupDirectory,'/home/app/backups-agent-control/ispagent');
  assert.deepEqual(calls,[['daemon-reload'],['enable','--now','agent-control-watch-ispagent.timer'],['enable','--now','agent-control-backup-ispagent.timer'],['enable','--now','agent-control-maintenance-ispagent.timer'],['enable','--now','agent-control-restore-proof-ispagent.timer']]);
  const dir=join(env.home,'.config/systemd/user');
  const watch=await readFile(join(dir,'agent-control-watch-ispagent.timer'),'utf8');
  const backup=await readFile(join(dir,'agent-control-backup-ispagent.timer'),'utf8');
  const watchService=await readFile(join(dir,'agent-control-watch-ispagent.service'),'utf8');
  const backupService=await readFile(join(dir,'agent-control-backup-ispagent.service'),'utf8');
  assert.match(watch,/OnBootSec=2min\nOnUnitActiveSec=2min/);
  assert.match(watch,/Persistent=true/);
  assert.match(backup,/OnCalendar=\*-\*-\* 03:30:00/);
  assert.match(backup,/Persistent=true/);
  const maintenance=await readFile(join(dir,'agent-control-maintenance-ispagent.timer'),'utf8');
  const restore=await readFile(join(dir,'agent-control-restore-proof-ispagent.timer'),'utf8');
  const maintenanceService=await readFile(join(dir,'agent-control-maintenance-ispagent.service'),'utf8');
  const restoreService=await readFile(join(dir,'agent-control-restore-proof-ispagent.service'),'utf8');
  assert.match(maintenance,/OnCalendar=Sun \*-\*-\* 04:00:00/);
  assert.match(restore,/OnCalendar=\*-\*-01 04:30:00/);
  assert.ok(maintenanceService.includes(`/usr/bin/node ${join(root,'scripts/personal-maintenance.mjs')} ${env.file} --manutencao-agendada`));
  assert.ok(restoreService.includes(`/usr/bin/node ${join(root,'scripts/personal-restore-proof.mjs')} ${env.file} /home/app/backups-agent-control/ispagent`));
  for(const text of [watchService,backupService,maintenanceService,restoreService]){
   assert.match(text,/Type=oneshot/);
   assert.equal(text.includes('Restart=always'),false);
   assert.equal(text.includes('s3cret'),false);
   assert.ok(text.includes(`WorkingDirectory=${root}`));
  }
  assert.ok(watchService.includes(`/usr/bin/node ${join(root,'scripts/personal-watch.mjs')} ${env.file}`));
  assert.ok(backupService.includes(`/usr/bin/node ${join(root,'scripts/personal-backup-rotate.mjs')} ${env.file} /home/app/backups-agent-control/ispagent`));
  calls.length=0;
  const removed=await runPersonalTimers([env.file,'--remove'],{home:env.home,systemctl:args=>{if(args[0]==='disable')throw new Error('missing');calls.push(args);}});
  assert.equal(JSON.parse(removed).removed.length,8);
  assert.deepEqual(calls,[['daemon-reload']]);
  for(const name of ['agent-control-watch-ispagent.service', 'agent-control-watch-ispagent.timer', 'agent-control-backup-ispagent.service', 'agent-control-backup-ispagent.timer', 'agent-control-maintenance-ispagent.service', 'agent-control-maintenance-ispagent.timer', 'agent-control-restore-proof-ispagent.service', 'agent-control-restore-proof-ispagent.timer']){
   assert.equal(await stat(join(dir,name)).then(()=>true,()=>false),false);
  }
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('timers refuse a locked installation before writing units',async()=>{
 const env=await fixture();
 const raw=JSON.parse(await readFile(env.file,'utf8')) as {activation:string};
 raw.activation='locked';
 await writeFile(env.file,JSON.stringify(raw)+'\n',{mode:0o600});
 await chmod(env.file,0o600);
 try{
  await assert.rejects(runPersonalTimers([env.file],{home:env.home,systemctl:()=>{throw new Error('systemctl');}}),(error:unknown)=>error instanceof Refusal&&error.code==='TIMERS_PERSONAL_REQUIRED');
  assert.equal(await stat(join(env.home,'.config/systemd/user')).then(()=>true,()=>false),false);
  await assert.rejects(runPersonalTimers([env.file,'extra'],{home:env.home,systemctl:()=>{throw new Error('systemctl');}}),(error:unknown)=>error instanceof Refusal&&error.code==='TIMERS_USAGE');
 }finally{await rm(env.root,{recursive:true,force:true});}
});
