import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import type {Installation} from '../src/installation.ts';
import {GATEWAY_RESTART_EVERY_MS,gatewayDownNotice,gatewayUpNotice,imagesRebuiltNotice,migrationsNotice,personalWatchImages,runPersonalWatch,spaceOverBudget,staleGrokLogin,staleLoginNotices} from '../src/personal-watch.ts';

const digest=(char:string)=>'sha256:'+char.repeat(64);
/** No journal, a roomy disk and no login problem, unless a test says otherwise. */
const quiet={retention:async()=>{},retentionTimerEnabled:async()=>true,recentLog:async()=>'',diskUsedPercent:async()=>50,logins:async()=>[],gatewayUnit:async()=>null,migrations:async()=>null};
const stopped=(exitStatus:number|null,activeState='failed')=>async()=>({activeState,exitStatus});

/** The last space measurement, in the format src/personal-disk.ts writes it: 25 GB (decimal) against a 20 GB budget. */
async function overBudget(data:string,gb=25,budgetGB:number|null=20){
 await writeFile(join(data,'space-last.json'),JSON.stringify({measuredAt:new Date().toISOString(),acBytes:gb*1e9,...(budgetGB===null?{}:{budgetGB})}),{mode:0o600});
}

async function fixture(activation:'personal'|'locked'='personal'){
 const root=await mkdtemp(join(tmpdir(),'personal-watch-'));
 const data=join(root,'ispagent'),repo=join(root,'repo'),id=randomUUID();
 await mkdir(data,{recursive:true,mode:0o700});
 await mkdir(repo,{recursive:true});
 const file=join(data,'installation.json');
 const body={schemaVersion:1,mode:'administration-only',activation,databaseUrl:'postgresql://ac:s3cret@127.0.0.1:54329/agent_control',dataDirectory:data,
  accountHomesDirectory:join(data,'accounts'),
  project:{id,label:'IspAgent',repo,owner:'owner@example.com'},projects:[],
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'}};
 await writeFile(file,JSON.stringify(body)+'\n',{mode:0o600});
 await chmod(file,0o600);
 return {root,data,file};
}

test('two health failures notify once and recovery notifies once',async()=>{
 const env=await fixture();
 const sent:string[]=[];
 const urls:string[]=[];
 let up=false;
 const run=()=>runPersonalWatch([env.file],{...quiet,probe:async url=>{urls.push(url);return up;},notify:async(_dir,body)=>{sent.push(body);}});
 try{
  assert.match(await run(),/^watch gateway=down failures=1 images=ok$/);
  assert.deepEqual(sent,[]);
  up=true;
  assert.match(await run(),/^watch gateway=up failures=0 images=ok$/);
  assert.deepEqual(sent,[]);
  up=false;
  assert.match(await run(),/^watch gateway=down failures=1 images=ok$/);
  assert.deepEqual(sent,[]);
  assert.match(await run(),/^watch gateway=down failures=2 images=ok notice=down$/);
  assert.deepEqual(sent,[gatewayDownNotice]);
  assert.match(await run(),/^watch gateway=down failures=3 images=ok$/);
  assert.deepEqual(sent,[gatewayDownNotice]);
  up=true;
  assert.match(await run(),/^watch gateway=up failures=0 images=ok notice=up$/);
  assert.deepEqual(sent,[gatewayDownNotice,gatewayUpNotice]);
  assert.match(await run(),/^watch gateway=up failures=0 images=ok$/);
  assert.deepEqual(sent,[gatewayDownNotice,gatewayUpNotice]);
  up=false;
  await run();
  await run();
  up=true;
  await run();
  await run();
  assert.deepEqual(sent,[gatewayDownNotice,gatewayUpNotice,gatewayDownNotice,gatewayUpNotice]);
  assert.deepEqual(urls,Array(urls.length).fill('http://127.0.0.1:8765/api/v1/ac/health'));
  const stateText=await readFile(join(env.data,'watch-state.json'),'utf8');
  assert.equal(stateText.includes('s3cret'),false);
  assert.equal((await stat(join(env.data,'watch-state.json'))).mode&0o777,0o600);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a corrupt watch state does not throw and starts the failure count again',async()=>{
 const env=await fixture();
 await writeFile(join(env.data,'watch-state.json'),'{',{mode:0o600});
 try{
  const line=await runPersonalWatch([env.file],{...quiet,probe:async()=>false,notify:async()=>{throw new Error('no');}});
  assert.match(line,/failures=1/);
  const state=JSON.parse(await readFile(join(env.data,'watch-state.json'),'utf8')) as {consecutiveFailures:number};
  assert.equal(state.consecutiveFailures,1);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a missing image is rebuilt at most once per hour and the gateway is restarted',async()=>{
 const env=await fixture();
 const image=digest('a');
 let now=Date.parse('2026-11-13T03:30:00.000Z');
 let rebuilds=0;
 let restarts:string[]=[];
 const sent:string[]=[];
 const run=()=>runPersonalWatch([env.file],{...quiet,
  now:()=>new Date(now),
  probe:async()=>true,
  images:()=>[image,'not-a-digest',image],
  inspectImage:async()=>false,
  rebuildImages:async file=>{rebuilds+=1;assert.equal(file,env.file);},
  restartGateway:async unit=>{restarts.push(unit);},
  notify:async(_dir,body)=>{sent.push(body);},
 });
 try{
  assert.match(await run(),/^watch gateway=up failures=0 images=rebuilt notice=images$/);
  assert.equal(rebuilds,1);
  assert.deepEqual(restarts,['agent-control-gateway-ispagent']);
  assert.deepEqual(sent,[imagesRebuiltNotice]);
  now+=30*60*1000;
  assert.match(await run(),/^watch gateway=up failures=0 images=skipped$/);
  assert.equal(rebuilds,1);
  now+=30*60*1000;
  await run();
  assert.equal(rebuilds,2);
  assert.equal(sent.every(body=>body===imagesRebuiltNotice&&!body.includes('s3cret')),true);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a failed image rebuild does not notify and does not run again within the hour',async()=>{
 const env=await fixture();
 let rebuilds=0;
 const sent:string[]=[];
 const run=()=>runPersonalWatch([env.file],{...quiet,
  now:()=>new Date('2026-11-13T03:30:00.000Z'),
  probe:async()=>true,
  images:()=>[digest('b')],
  inspectImage:async()=>false,
  rebuildImages:async()=>{rebuilds+=1;throw new Error('docker down');},
  restartGateway:async()=>{throw new Error('should not restart');},
  notify:async(_dir,body)=>{sent.push(body);},
 });
 try{
  assert.match(await run(),/images=failed/);
  assert.match(await run(),/images=skipped/);
  assert.equal(rebuilds,1);
  assert.deepEqual(sent,[]);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('watch reads the four native images and ignores a locked installation',async()=>{
 const images=personalWatchImages({nativeBootstrap:{state:'active',planning:{imageId:digest('a')},execution:{workerImage:digest('b'),toolsImage:digest('c')},qa:{image:digest('d')}}} as Installation);
 assert.deepEqual(images,[digest('a'),digest('b'),digest('c'),digest('d')]);
 assert.deepEqual(personalWatchImages({} as Installation),[]);
 assert.deepEqual(personalWatchImages({nativeBootstrap:{state:'disabled'}} as Installation),[]);
 assert.deepEqual(personalWatchImages({nativeBootstrap:{state:'bench'}} as Installation),[]);
 const env=await fixture('locked');
 try{
  await assert.rejects(runPersonalWatch([env.file],{...quiet,probe:async()=>{throw new Error('probed');}}),(error:unknown)=>error instanceof Refusal&&error.code==='WATCH_PERSONAL_REQUIRED');
  await assert.rejects(runPersonalWatch([]),(error:unknown)=>error instanceof Refusal&&error.code==='WATCH_USAGE');
  assert.equal(await stat(join(env.data,'watch-state.json')).then(()=>true,()=>false),false);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('the watch relays the gateway warning when personal egress is disabled',async()=>{
 const env=await fixture();
 const sent:string[]=[];
 let log='';
 const run=()=>runPersonalWatch([env.file],{...quiet,probe:async()=>true,recentLog:async()=>log,
  notify:async(_dir,body)=>{sent.push(body);}});
 try{
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  log='(node:123) [PERSONAL_EGRESS_DISABLED] Warning: Proxy de saída pessoal desativado por AC_PERSONAL_EGRESS=0.';
  assert.equal(await run(),'watch gateway=up failures=0 images=ok notice=egress');
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  assert.deepEqual(sent,['Proxy de saída pessoal desativado por AC_PERSONAL_EGRESS=0.']);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('repeated errors, a full disk and an expiring login notify at their own pace',async()=>{
 const env=await fixture();
 const sent:string[]=[];
 let now=new Date('2026-11-16T12:00:00Z'),log='',disk=50,logins:{key:string;text:string;repeatMs:number}[]=[];
 const run=()=>runPersonalWatch([env.file],{retention:async()=>{},retentionTimerEnabled:async()=>true,now:()=>now,probe:async()=>true,notify:async(_dir,body)=>{sent.push(body);},images:()=>[],
  recentLog:async()=>log,diskUsedPercent:async()=>disk,logins:async()=>logins});
 try{
  const line='RECONCILIATION_FAILED NATIVE_JOB_RECONCILIATION_FAILED: d766dbd8-ebb9-4eb1-9c66-4445bdfd4481 NATIVE_EXECUTION_SUPERVISOR_UNAVAILABLE';
  log=Array(9).fill(line).join('\n');
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  log=Array(12).fill(line).concat(Array(40).fill('{"event":"PERSONAL_NOTICE_SUPPRESSED","text":"Tarefa na fila."}')).join('\n');
  assert.equal(await run(),'watch gateway=up failures=0 images=ok notice=error');
  assert.match(sent[0]!,/^Erro repetido no Agent Control \(12 vezes em 5 min\): RECONCILIATION_FAILED NATIVE_JOB_RECONCILIATION_FAILED: \* NATIVE_EXECUTION_SUPERVISOR_UNAVAILABLE$/);
  now=new Date('2026-11-16T12:30:00Z');
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  now=new Date('2026-11-16T13:01:00Z');
  assert.equal(await run(),'watch gateway=up failures=0 images=ok notice=error');
  log='';disk=93;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok notice=disk');
  assert.match(sent.at(-1)!,/^Disco do servidor em 93%/);
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  disk=50;logins=[{key:'login:abc',text:'O login do Claude vence em 2 dias.',repeatMs:24*3600_000}];
  assert.equal(await run(),'watch gateway=up failures=0 images=ok notice=login');
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  assert.equal(sent.length,4);
  // A notice that could not be sent is tried again on the next check.
  logins=[{key:'login:def',text:'O Grok está sem login válido.',repeatMs:24*3600_000}];
  let failing=true;
  const flaky=()=>runPersonalWatch([env.file],{retention:async()=>{},retentionTimerEnabled:async()=>true,now:()=>now,probe:async()=>true,notify:async(_dir,body)=>{if(failing)throw new Error('push down');sent.push(body);},images:()=>[],
   recentLog:async()=>'',diskUsedPercent:async()=>50,logins:async()=>logins});
  assert.equal(await flaky(),'watch gateway=up failures=0 images=ok');
  failing=false;
  assert.equal(await flaky(),'watch gateway=up failures=0 images=ok notice=login');
  assert.equal(sent.at(-1),'O Grok está sem login válido.');
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('vigia executa manutenção e envia alerta no limite mesmo com imagem ausente',async()=>{
 const env=await fixture();
 try{
  const calls:string[]=[];
  await overBudget(env.data);
  const status=await runPersonalWatch([env.file],{...quiet,retention:async file=>{calls.push(file);},
   probe:async()=>true,notify:async(_dir,message)=>{calls.push(message);},images:()=>[digest('a')],
   inspectImage:async()=>false,rebuildImages:async()=>{assert.fail('rebuild com disco crítico');},diskUsedPercent:async()=>95});
  assert.match(calls[0]!,/95%.*bloqueados/);
  assert.equal(calls[1],env.file);
  assert.match(status,/images=skipped retention=over-budget/);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('vigia alerta e executa a retenção mesmo quando o estado não pode ser gravado (ENOSPC)',async()=>{
 const env=await fixture();
 try{
  const calls:string[]=[];
  await overBudget(env.data);
  // A read-only data directory fails every state write the way a full volume does.
  await chmod(env.data,0o500);
  const status=await runPersonalWatch([env.file],{...quiet,
   retention:async()=>{calls.push('retention');},
   diskUsedPercent:async()=>{calls.push('sample');return 97;},
   probe:async()=>true,notify:async(_dir,message)=>{calls.push(message);},images:()=>[digest('a')],
   inspectImage:async()=>false,rebuildImages:async()=>{assert.fail('rebuild com disco crítico');}});
  assert.equal(calls[0],'sample');
  assert.match(calls[1]!,/97%.*bloqueados/);
  assert.equal(calls[2],'retention');
  assert.equal(calls.length,3);
  assert.match(status,/images=skipped/);
  assert.match(status,/state=unsaved/);
 }finally{await chmod(env.data,0o700);await rm(env.root,{recursive:true,force:true});}
});

test('sem estado gravável o vigia não reconstrói imagens e a falha da retenção não esconde o resto',async()=>{
 const env=await fixture();
 try{
  await overBudget(env.data);
  await chmod(env.data,0o500);
  const status=await runPersonalWatch([env.file],{...quiet,retention:async()=>{throw new Error('ENOSPC');},
   probe:async()=>true,notify:async()=>{},images:()=>[digest('a')],inspectImage:async()=>false,
   rebuildImages:async()=>{assert.fail('o limite de uma hora não pode ser registrado');}});
  assert.equal(status,'watch gateway=up failures=0 images=skipped retention=failed state=unsaved');
 }finally{await chmod(env.data,0o700);await rm(env.root,{recursive:true,force:true});}
});

test('uma falha ao ler o estado ainda deixa a retenção rodar e depois propaga o erro',async()=>{
 const env=await fixture();
 try{
  await mkdir(join(env.data,'watch-state.json'));
  await overBudget(env.data);
  const calls:string[]=[];
  await assert.rejects(runPersonalWatch([env.file],{...quiet,diskUsedPercent:async()=>97,retention:async()=>{calls.push('limpeza');},
   probe:async()=>true,notify:async(_dir,message)=>{calls.push(message);},images:()=>[]}),{code:'EISDIR'});
  assert.match(calls[0]!,/97%.*bloqueados/);
  assert.equal(calls[1],'limpeza');
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('automatic retention defaults to preview and only apply enables deletion',async()=>{
 const env=await fixture();
 try{
  const observed:boolean[]=[];
  await overBudget(env.data);
  // Each pass is past the 30-minute spacing of the watch's own retention.
  let now=Date.parse('2026-11-28T00:00:00Z');
  const invoke=()=>runPersonalWatch([env.file],{...quiet,now:()=>new Date(now+=3600_000),retention:async(_file,apply)=>{observed.push(apply);},probe:async()=>true,notify:async()=>{}});
  await invoke();
  const body=JSON.parse(await readFile(env.file,'utf8'));
  for(const automatic of ['off','preview','apply']){body.retention={automatic};await writeFile(env.file,JSON.stringify(body));await invoke();}
  assert.deepEqual(observed,[false,false,true]);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a gateway stopped with exit 78 gets the personal:update notice and is never restarted',async()=>{
 const env=await fixture();
 const sent:string[]=[];
 const restarts:string[]=[];
 const units:string[]=[];
 try{
  const run=()=>runPersonalWatch([env.file],{...quiet,probe:async()=>false,gatewayUnit:async unit=>{units.push(unit);return {activeState:'failed',exitStatus:78};},
   restartGateway:async unit=>{restarts.push(unit);},notify:async(_dir,body)=>{sent.push(body);}});
  assert.equal(await run(),'watch gateway=down failures=1 images=ok notice=migrations');
  assert.deepEqual(sent,[migrationsNotice(env.file)]);
  assert.match(sent[0]!,new RegExp(`rode npm run personal:update -- ${env.file.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')}$`,'i'));
  // The same notice waits an hour; the generic down notice still follows the two-failure rule.
  assert.equal(await run(),'watch gateway=down failures=2 images=ok notice=down');
  assert.deepEqual(restarts,[]);
  assert.deepEqual(units,['agent-control-gateway-ispagent','agent-control-gateway-ispagent']);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('another exit status or a running gateway does not send the migration notice',async()=>{
 const env=await fixture();
 const sent:string[]=[];
 try{
  for(const unit of [stopped(1),stopped(78,'active'),async()=>null]){
   const line=await runPersonalWatch([env.file],{...quiet,probe:async()=>false,gatewayUnit:unit,restartGateway:async()=>{},notify:async(_dir,body)=>{sent.push(body);}});
   assert.equal(line.includes('migrations'),false);
  }
  assert.equal(sent.some(body=>body.includes('personal:update')),false);
  // A healthy gateway is not even asked for its exit status.
  await runPersonalWatch([env.file],{...quiet,probe:async()=>true,gatewayUnit:async()=>{assert.fail('asked while up');},notify:async()=>{}});
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('images are rebuilt but a pending migration keeps the gateway from being restarted',async()=>{
 const env=await fixture();
 const sent:string[]=[];
 let restarts=0,rebuilds=0;
 try{
  let now=Date.parse('2026-11-28T00:00:00Z'),present=false,pending:string|null='MIGRATIONS_PENDING';
  const run=()=>runPersonalWatch([env.file],{...quiet,now:()=>new Date(now),probe:async()=>true,images:()=>[digest('a')],inspectImage:async()=>present,
   rebuildImages:async()=>{rebuilds+=1;present=true;},restartGateway:async()=>{restarts+=1;},migrations:async()=>pending,notify:async(_dir,body)=>{sent.push(body);}});
  assert.equal(await run(),'watch gateway=up failures=0 images=rebuilt restart=skipped notice=migrations');
  // The images are there now, but the restart is still owed: once personal:update fixed the schema, it happens.
  now+=2*60_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok restart=skipped');
  pending=null;now+=2*60_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok notice=images');
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  assert.equal(rebuilds,1);
  assert.equal(restarts,1);
  assert.deepEqual(sent,[migrationsNotice(env.file),imagesRebuiltNotice]);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('below the budget, or without a measurement, the watch never runs the retention itself',async()=>{
 const env=await fixture();
 let runs=0;
 try{
  const run=(percent=50)=>runPersonalWatch([env.file],{...quiet,diskUsedPercent:async()=>percent,retention:async()=>{runs+=1;},probe:async()=>true,notify:async()=>{}});
  // No space-last.json: unknown, no retention, even with the disk at 97%.
  assert.equal(await run(97),'watch gateway=up failures=0 images=ok notice=disk');
  await writeFile(join(env.data,'space-last.json'),'{',{mode:0o600});
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  await overBudget(env.data,19.9);
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  // A larger budget in storage keeps 25 GB inside it.
  await overBudget(env.data,25,null);
  const body=JSON.parse(await readFile(env.file,'utf8'));
  body.storage={budgetGB:30};
  await writeFile(env.file,JSON.stringify(body));
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  assert.equal(runs,0);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('over the budget the watch runs the retention at most every 30 minutes',async()=>{
 const env=await fixture();
 const applied:boolean[]=[];
 let now=Date.parse('2026-11-28T00:00:00Z');
 try{
  await overBudget(env.data);
  const run=()=>runPersonalWatch([env.file],{...quiet,now:()=>new Date(now),retention:async(_file,apply)=>{applied.push(apply);},probe:async()=>true,notify:async()=>{}});
  assert.equal(await run(),'watch gateway=up failures=0 images=ok retention=over-budget');
  now+=10*60_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  now+=21*60_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok retention=over-budget');
  assert.deepEqual(applied,[false,false]);
  const body=JSON.parse(await readFile(env.file,'utf8'));
  body.retention={automatic:'off'};
  await writeFile(env.file,JSON.stringify(body));
  now+=3600_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  assert.equal(applied.length,2);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('an enabled Grok login whose token was not refreshed for days is reported as expired',async()=>{
 const now=new Date('2026-11-28T12:00:00Z');
 const entry=(expires:string)=>({'https://auth.x.ai::x':{refresh_token:'r',expires_at:expires}});
 assert.equal(staleGrokLogin(entry('2026-11-16T20:20:58Z'),now)?.toISOString(),'2026-11-16T20:20:58.000Z');
 // A token that expired today is refreshed on the next use: no notice.
 assert.equal(staleGrokLogin(entry('2026-11-28T06:00:00Z'),now),null);
 assert.equal(staleGrokLogin(entry('not a date'),now),null);
 assert.equal(staleGrokLogin(null,now),null);
 const id='ba6bfaec-5918-4a30-972b-133a47365fd5',claude='11111111-2222-3333-4444-555555555555';
 const files:Record<string,string>={[join('/contas',id,'.grok/auth.json')]:JSON.stringify(entry('2026-11-16T20:20:58Z')),
  [join('/contas',claude,'.grok/auth.json')]:JSON.stringify(entry('2026-11-16T20:20:58Z'))};
 const notices=await staleLoginNotices('/contas',[{id,provider:'grok'},{id:claude,provider:'claude'},{id:'..',provider:'grok'}],now,'/inst/installation.json',async path=>{
  const text=files[path];if(text===undefined)throw Object.assign(new Error('missing'),{code:'ENOENT'});return text;});
 assert.equal(notices.length,1);
 assert.equal(notices[0]!.key,'login-stale:'+id);
 assert.match(notices[0]!.text,/^O login do Grok \(conta ba6bfaec\) não é renovado desde 16\/11 e a conta continua habilitada\. Se o Grok recusar, entre de novo: npm run gateway -- account-add \/inst\/installation\.json grok Grok/);
 assert.equal(notices[0]!.text.includes('refresh_token'),false);
 // A missing file is left to loginNotices, which reports it as "sem login válido".
 assert.deepEqual(await staleLoginNotices('/contas',[{id:'22222222-2222-3333-4444-555555555555',provider:'grok'}],now,'/i.json',async()=>{throw new Error('ENOENT');}),[]);
});

test('each watch pass returns one summary line',async()=>{
 const env=await fixture();
 try{
  await overBudget(env.data);
  const line=await runPersonalWatch([env.file],{...quiet,probe:async()=>false,gatewayUnit:stopped(78),notify:async()=>{}});
  assert.equal(line.includes('\n'),false);
  assert.match(line,/^watch gateway=down /);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a gateway systemd gave up on is restarted at most every 15 minutes, never on exit 78 or a pending schema',async()=>{
 const env=await fixture();
 const sent:string[]=[];
 const restarts:string[]=[];
 let now=Date.parse('2026-11-28T00:00:00Z'),unit=stopped(1),migrations:()=>Promise<string|null>=async()=>null;
 const run=()=>runPersonalWatch([env.file],{...quiet,now:()=>new Date(now),probe:async()=>false,gatewayUnit:unit,migrations:()=>migrations(),
  restartGateway:async name=>{restarts.push(name);},notify:async(_dir,body)=>{sent.push(body);}});
 try{
  assert.equal(await run(),'watch gateway=down failures=1 images=ok restart=done');
  assert.deepEqual(restarts,['agent-control-gateway-ispagent']);
  now+=2*60_000;
  assert.equal(await run(),'watch gateway=down failures=2 images=ok notice=down');
  now+=GATEWAY_RESTART_EVERY_MS-2*60_000;
  assert.equal(await run(),'watch gateway=down failures=3 images=ok restart=done');
  assert.equal(restarts.length,2);
  // Database unreachable: no restart, no false migration notice, and the next pass tries again.
  now+=GATEWAY_RESTART_EVERY_MS;migrations=async()=>{throw new Error('ECONNREFUSED');};
  assert.equal(await run(),'watch gateway=down failures=4 images=ok restart=waiting');
  migrations=async()=>'MIGRATIONS_PENDING';
  assert.equal(await run(),'watch gateway=down failures=5 images=ok restart=skipped notice=migrations');
  // Exit 78 and a unit stopped on purpose are left alone.
  migrations=async()=>null;now+=GATEWAY_RESTART_EVERY_MS;
  for(const state of [stopped(78),stopped(1,'inactive')]){unit=state;await run();}
  assert.equal(restarts.length,2);
  assert.equal(sent.filter(body=>body===migrationsNotice(env.file)).length,1);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a schema check that fails after a rebuild is not reported as a migration and the restart follows on the next pass',async()=>{
 const env=await fixture();
 const sent:string[]=[];
 let restarts=0,present=false,down=true,now=Date.parse('2026-11-28T00:00:00Z');
 const run=()=>runPersonalWatch([env.file],{...quiet,now:()=>new Date(now),probe:async()=>true,images:()=>[digest('a')],inspectImage:async()=>present,
  rebuildImages:async()=>{present=true;},restartGateway:async()=>{restarts+=1;},
  migrations:async()=>{if(down)throw new Error('pool refused');return null;},notify:async(_dir,body)=>{sent.push(body);}});
 try{
  assert.equal(await run(),'watch gateway=up failures=0 images=rebuilt restart=waiting');
  assert.equal(restarts,0);
  assert.deepEqual(sent,[]);
  down=false;now+=2*60_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok notice=images');
  assert.equal(restarts,1);
  assert.deepEqual(sent,[imagesRebuiltNotice]);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('over budget means the same as the exam gate: decimal gigabytes, the budget itself included',async()=>{
 assert.equal(spaceOverBudget({acBytes:20e9,budgetGB:20},20),true);
 assert.equal(spaceOverBudget({acBytes:20e9-1,budgetGB:20},20),false);
 // The budget recorded with the reading wins; without it, the configured one.
 assert.equal(spaceOverBudget({acBytes:25e9,budgetGB:30},20),false);
 assert.equal(spaceOverBudget({acBytes:25e9,budgetGB:null},20),true);
 assert.equal(spaceOverBudget(null,20),false);
 const env=await fixture();
 let runs=0;
 try{
  await overBudget(env.data,20);
  assert.equal(await runPersonalWatch([env.file],{...quiet,retention:async()=>{runs+=1;},probe:async()=>true,notify:async()=>{}}),'watch gateway=up failures=0 images=ok retention=over-budget');
  assert.equal(runs,1);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('the stale Grok notice has its own key and a file rewritten after the expiry is not stale',async()=>{
 const now=new Date('2026-11-28T12:00:00Z');
 const raw={'https://auth.x.ai::x':{refresh_token:'r',expires_at:'2026-11-16T20:20:58Z'}};
 assert.equal(staleGrokLogin(raw,now,Date.parse('2026-11-27T00:00:00Z')),null);
 assert.notEqual(staleGrokLogin(raw,now,Date.parse('2026-11-16T14:20:58Z')),null);
 const id='ba6bfaec-5918-4a30-972b-133a47365fd5';
 const read=async()=>JSON.stringify(raw);
 assert.deepEqual(await staleLoginNotices('/contas',[{id,provider:'grok'}],now,'/i.json',read,async()=>Date.parse('2026-11-27T00:00:00Z')),[]);
 const stale=await staleLoginNotices('/contas',[{id,provider:'grok'}],now,'/i.json',read,async()=>Date.parse('2026-11-16T14:20:58Z'));
 // Both notices about one account go out in the same pass; neither silences the other.
 const env=await fixture();
 const sent:string[]=[];
 try{
  const logins=async()=>[{key:'login:'+id,text:'O Grok está sem login válido.',repeatMs:24*3600_000},...stale];
  assert.equal(await runPersonalWatch([env.file],{...quiet,logins,probe:async()=>true,notify:async(_dir,body)=>{sent.push(body);}}),'watch gateway=up failures=0 images=ok notice=login+login-stale');
  assert.equal(sent.length,2);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('until the hourly retention timer is installed the watch keeps running the retention every hour',async()=>{
 const env=await fixture();
 const timers:string[]=[];
 let runs=0,enabled=false,now=Date.parse('2026-11-28T00:00:00Z');
 const run=()=>runPersonalWatch([env.file],{...quiet,now:()=>new Date(now),retention:async()=>{runs+=1;},
  retentionTimerEnabled:async timer=>{timers.push(timer);return enabled;},probe:async()=>true,notify:async()=>{}});
 try{
  assert.equal(await run(),'watch gateway=up failures=0 images=ok retention=no-timer');
  now+=30*60_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  now+=30*60_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok retention=no-timer');
  enabled=true;now+=3600_000;
  assert.equal(await run(),'watch gateway=up failures=0 images=ok');
  assert.equal(runs,2);
  assert.equal(timers.at(-1),'agent-control-retention-ispagent.timer');
 }finally{await rm(env.root,{recursive:true,force:true});}
});
