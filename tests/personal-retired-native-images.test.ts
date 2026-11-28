import assert from 'node:assert/strict';
import {createHash,createPublicKey,generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Installation,loadInstallation} from '../src/installation.ts';
import {Ledger} from '../src/ledger.ts';
import {nativeExecutionExecutorDigest} from '../src/native-execution-contract.ts';
import {nativePlanningExecutorDigest} from '../src/native-planning-contract.ts';
import {nativeQaContractDigest,type NativeQaContract} from '../src/native-qa-contract.ts';
import {nativeReviewVerifierDigest} from '../src/native-review-contract.ts';
import {protectedDigests} from '../src/personal-artifact-retention.ts';
import {runRetentionStages} from '../src/personal-maintenance.ts';
import {retireNativeImages} from '../src/personal-retired-native-images.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const hash=(seed:string)=>createHash('sha256').update(seed).digest('hex');
const image=(seed:string)=>'sha256:'+hash(seed);
const qa:NativeQaContract={schemaVersion:1,id:'native-qa-retired',image:image('qa'),argv:['/usr/bin/true'],environment:['PATH=/usr/bin'],timeoutMs:1000,memoryBytes:67108864,pids:16,nanoCpus:100000000};
const keyPem=()=>generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString();
const fingerprint=(pem:string)=>createHash('sha256').update(createPublicKey(pem).export({format:'der',type:'spki'})).digest('hex');

const current={planning:image('planning-now'),worker:image('worker-now'),tools:image('tools-now')};
const oldPairs=[{workerImage:image('worker-old-1'),toolsImage:image('tools-old-1')},{workerImage:image('worker-old-2'),toolsImage:current.tools}];
const oldPlanning=[image('planning-old-1'),image('planning-old-2')];

async function installation(databaseUrl='postgres://invalid.example/none'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-retired-native-')));
 const data=join(root,'data'),repo=join(root,'repo');
 await mkdir(data,{mode:0o700});await mkdir(repo);
 const dirs=['plan-host','plan-account','exec-host','exec-account'].map(name=>join(data,name));
 for(const dir of dirs)await mkdir(dir,{mode:0o700});
 const pems={planning:keyPem(),execution:keyPem(),review:keyPem()};
 for(const [name,text] of Object.entries(pems))await writeFile(join(data,name+'.pem'),text,{mode:0o600});
 const projectId=randomUUID();
 const raw={schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl,dataDirectory:data,
  project:{id:projectId,label:'p',repo,owner:'owner'},http:{listen:'127.0.0.1',port:18443,publicOrigin:'http://127.0.0.1:18443'},
  nativeBootstrap:{state:'configured',contract:'native-bootstrap-configured-v1',projectId,contextId:randomUUID(),epoch:3,instanceId:randomUUID(),source:'authorized-endpoint',
   accounts:[{accountId:randomUUID(),subjectDigest:hash('subject')}],
   planning:{id:'native-plan',imageId:current.planning,retiredImageIds:oldPlanning,executorDigest:nativePlanningExecutorDigest(current.planning),signingKeyFile:join(data,'planning.pem'),keyFingerprint:fingerprint(pems.planning),hostRoot:dirs[0],accountRoot:dirs[1]},
   execution:{id:'native-exec',workerImage:current.worker,toolsImage:current.tools,retiredImages:oldPairs,executorDigest:nativeExecutionExecutorDigest(current.worker,current.tools),signingKeyFile:join(data,'execution.pem'),keyFingerprint:fingerprint(pems.execution),hostRoot:dirs[2],accountRoot:dirs[3],providerNetworkId:hash('network'),workerEnv:['PATH=/usr/bin'],toolsEnv:['PATH=/usr/bin']},
   qa,qaDigest:nativeQaContractDigest(qa),review:{signingKeyFile:join(data,'review.pem'),keyFingerprint:fingerprint(pems.review),verifierDigest:nativeReviewVerifierDigest}}};
 const file=join(root,'installation.json');
 await writeFile(file,JSON.stringify(raw,null,2)+'\n',{mode:0o600});
 try{return {root,data,file,config:await loadInstallation(file)};}
 catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
const backups=async(root:string)=>(await readdir(root)).filter(name=>name.startsWith('installation.json.before-retired-images-'));
const leftovers=async(root:string)=>(await readdir(root)).filter(name=>name.endsWith('.tmp'));

test('a retired pair or planning image that a job or call may still need stays; the preview changes nothing',async()=>{
 const env=await installation();
 try{
  const before=await readFile(env.file,'utf8');
  const busyExecution=nativeExecutionExecutorDigest(oldPairs[0]!.workerImage,oldPairs[0]!.toolsImage),busyPlanning=nativePlanningExecutorDigest(oldPlanning[1]!);
  const seen:string[]=[];
  const deps={executionInUse:async(digest:string)=>{seen.push(digest);return digest===busyExecution?1:0;},planningInUse:async(digest:string)=>{seen.push(digest);return digest===busyPlanning?2:0;}};
  const preview=await retireNativeImages(env.config,env.file,false,deps);
  assert.equal(preview.config,undefined);
  assert.equal(await readFile(env.file,'utf8'),before);
  assert.deepEqual(await backups(env.root),[]);
  assert.match(preview.lines.join('\n'),/sairiam da instalação: 1 par\(es\) de execução e 1 imagem\(ns\) de planejamento/);
  // Every entry is judged by its own executor digest, the identity the jobs and calls are bound to.
  assert.deepEqual(new Set(seen),new Set([busyExecution,nativeExecutionExecutorDigest(oldPairs[1]!.workerImage,oldPairs[1]!.toolsImage),nativePlanningExecutorDigest(oldPlanning[0]!),busyPlanning]));

  const applied=await retireNativeImages(env.config,env.file,true,{...deps,now:()=>new Date('2026-11-28T10:00:00Z')});
  const written=JSON.parse(await readFile(env.file,'utf8'));
  assert.deepEqual(written.nativeBootstrap.execution.retiredImages,[oldPairs[0]]);
  assert.deepEqual(written.nativeBootstrap.planning.retiredImageIds,[oldPlanning[1]]);
  assert.equal((await stat(env.file)).mode&0o777,0o600);
  assert.deepEqual(await backups(env.root),['installation.json.before-retired-images-20261128-100000']);
  assert.equal(await readFile(join(env.root,'installation.json.before-retired-images-20261128-100000'),'utf8'),before);
  assert.equal((await stat(join(env.root,'installation.json.before-retired-images-20261128-100000'))).mode&0o777,0o600);
  assert.deepEqual(await leftovers(env.root),[]);
  assert.ok(Installation.safeParse(written).success);
  assert.deepEqual(applied.config?.nativeBootstrap,(await loadInstallation(env.file)).nativeBootstrap);
  assert.match(applied.lines.join('\n'),/retiradas da instalação: 1 par\(es\) de execução e 1 imagem\(ns\) de planejamento; backup em/);
  assert.match(applied.lines.join('\n'),/Par de execução aposentado preservado/);

  // The dropped worker image is no longer protected; the kept pair, the kept planning image and the current pair still are.
  const guards=await protectedDigests(applied.config!,{productRoot:join(env.root,'no-product'),sharedRefsRoot:join(env.root,'refs'),verifyRunImages:async()=>[]},
   async args=>args[0]==='info'?{code:0,stdout:'daemon-retired\n'}:{code:1,stdout:''});
  const all=new Set([...guards.pinned,...guards.retired]);
  assert.equal(all.has(oldPairs[1]!.workerImage),false);
  assert.equal(all.has(oldPlanning[0]!),false);
  for(const kept of [oldPairs[0]!.workerImage,oldPairs[0]!.toolsImage,oldPlanning[1]!,current.tools,current.worker,current.planning])assert.ok(all.has(kept),kept);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a database that cannot answer, or an installation.json changed since it was read, keeps every retired entry',async()=>{
 const env=await installation();
 try{
  const before=await readFile(env.file,'utf8');
  const down=await retireNativeImages(env.config,env.file,true,{executionInUse:async()=>{throw new Error('down');},planningInUse:async()=>0});
  assert.match(down.lines.join('\n'),/o banco não respondeu/);
  assert.equal(await readFile(env.file,'utf8'),before);
  const changed=JSON.parse(before);changed.nativeBootstrap.execution.retiredImages=[oldPairs[1]];
  await writeFile(env.file,JSON.stringify(changed,null,2)+'\n',{mode:0o600});
  const raced=await retireNativeImages(env.config,env.file,true,{executionInUse:async()=>0,planningInUse:async()=>0});
  assert.match(raced.lines.join('\n'),/installation.json mudou desde a leitura/);
  assert.deepEqual(JSON.parse(await readFile(env.file,'utf8')),changed);
  assert.deepEqual(await backups(env.root),[]);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('the retention stage runs before the image retention, hands it the new installation and only with the installation file',async()=>{
 const env=await installation();
 try{
  const order:string[]=[];
  const stub=(name:string)=>async(config:Installation)=>{order.push(name+':'+((config.nativeBootstrap as {execution?:{retiredImages?:unknown[]}}).execution?.retiredImages?.length??0));return [];};
  const deps={jobRetention:stub('jobs'),jobDirRetention:stub('job-dirs'),verifyDatabaseRetention:stub('verify-db'),capacityWaitRetention:stub('waits'),devWorktreeRetention:stub('dev'),artifactRetention:stub('artifacts')};
  await runRetentionStages(env.config,true,deps);
  assert.deepEqual(order,['jobs:2','job-dirs:2','verify-db:2','waits:2','dev:2','artifacts:2']);
  order.length=0;
  await runRetentionStages(env.config,true,{...deps,installationFile:env.file,retiredNativeImages:(config,file,apply)=>retireNativeImages(config,file,apply,{executionInUse:async()=>0,planningInUse:async()=>0})});
  assert.deepEqual(order,['jobs:2','job-dirs:2','verify-db:2','waits:2','dev:2','artifacts:0']);
  assert.equal(JSON.parse(await readFile(env.file,'utf8')).nativeBootstrap.execution.retiredImages,undefined);
  assert.equal(JSON.parse(await readFile(env.file,'utf8')).nativeBootstrap.planning.retiredImageIds,undefined);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('the default queries read the executor bindings of jobs and planning calls in the real schema',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const fixture=await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!,'retired_native');
 try{
  const ledger=new Ledger(fixture.url);
  try{await ledger.migrate();}finally{await ledger.close();}
  const env=await installation(fixture.url);
  try{
   // Empty journals: nothing can still need the retired entries, so the whole lists go.
   const applied=await retireNativeImages(env.config,env.file,true);
   assert.match(applied.lines.join('\n'),/retiradas da instalação: 2 par\(es\) de execução e 2 imagem\(ns\) de planejamento/);
  }finally{await rm(env.root,{recursive:true,force:true});}
 }finally{await fixture.close();}
});

test('a gateway started before the last change of installation.json keeps every retired entry; one started after lets them be judged',async()=>{
 const env=await installation();
 try{
  const before=await readFile(env.file,'utf8');
  const changed=(await stat(env.file)).mtimeMs;
  const free={executionInUse:async()=>0,planningInUse:async()=>0};
  const old=await retireNativeImages(env.config,env.file,true,{...free,gatewayStarts:async()=>[new Date(changed+60_000),new Date(changed-1000)]});
  assert.match(old.lines.join('\n'),/o gateway em execução começou antes da última mudança de installation.json/);
  assert.equal(old.config,undefined);
  const unknown=await retireNativeImages(env.config,env.file,true,{...free,gatewayStarts:async()=>{throw new Error('no /proc');}});
  assert.match(unknown.lines.join('\n'),/não foi possível saber quando o gateway/);
  assert.equal(await readFile(env.file,'utf8'),before);
  assert.deepEqual(await backups(env.root),[]);
  const fresh=await retireNativeImages(env.config,env.file,true,{...free,gatewayStarts:async()=>[new Date(changed+60_000)]});
  assert.match(fresh.lines.join('\n'),/retiradas da instalação: 2 par\(es\)/);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('the gateway start times come from the processes that serve this exact installation file',{skip:process.platform!=='linux'},async()=>{
 const env=await installation();
 const {spawn}=await import('node:child_process');
 const serve=(file:string)=>spawn(process.execPath,['-e','setTimeout(()=>{},60000)',join(env.root,'src','server-main.ts'),'serve',file],{stdio:'ignore'});
 const ours=serve(env.file),other=serve(join(env.root,'other.json'));
 try{
  await new Promise(done=>setTimeout(done,300));
  const {gatewayStartTimes}=await import('../src/personal-retired-native-images.ts');
  const starts=await gatewayStartTimes(env.file);
  assert.equal(starts.length,1);
  assert.ok(Math.abs(starts[0]!.getTime()-Date.now())<10_000,starts[0]!.toISOString());
 }finally{
  for(const child of [ours,other]){child.kill();await new Promise(done=>child.once('exit',done));}
  await rm(env.root,{recursive:true,force:true});
 }
});

test('a gateway in another mount namespace is matched by device and inode, and a serve process that cannot be seen into is counted',{skip:process.platform!=='linux'||process.getuid?.()===0},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-retired-proc-')));
 const {chmod,link,symlink}=await import('node:fs/promises');
 try{
  const host=join(root,'host','installation.json');
  await mkdir(join(root,'host'));await writeFile(host,'{}');
  const proc=join(root,'proc');
  await mkdir(join(proc,'self'),{recursive:true});
  await writeFile(join(proc,'stat'),'cpu 0\nbtime 1000000000\n');
  const mountinfo='25 1 0:5 / /proc rw,nosuid - proc proc rw\n';
  await writeFile(join(proc,'self','mountinfo'),mountinfo);
  // A process started `ticks` hundredths of a second after boot, serving `file`, with `cwd` and `root` as given.
  const pid=async(id:number,ticks:number,file:string,view:'container'|'other'|'hidden'|'absent')=>{
   const dir=join(proc,String(id));
   await mkdir(dir);
   await writeFile(join(dir,'cmdline'),['node','--import','tsx','src/server-main.ts','serve',file,''].join('\0'));
   await writeFile(join(dir,'stat'),`${id} (node) S `+Array.from({length:19},(_,index)=>index===18?String(ticks):'0').join(' ')+' 0 0');
   const fs=join(root,'fs-'+id);
   await mkdir(join(fs,'data'),{recursive:true});
   await mkdir(join(fs,'workspace'));
   if(view==='container')await link(host,join(fs,'data','installation.json'));
   if(view==='other')await writeFile(join(fs,'data','installation.json'),'{}');
   if(view==='hidden')await chmod(join(fs,'data'),0o000);
   await symlink(fs,join(dir,'root'));
   await symlink('/workspace',join(dir,'cwd'));
  };
  const {gatewayStartTimes}=await import('../src/personal-retired-native-images.ts');
  await pid(101,100,'/data/installation.json','container');
  await pid(102,200,'/data/installation.json','other');
  await pid(103,300,'/data/installation.json','absent');
  assert.deepEqual((await gatewayStartTimes(host,proc)).map(date=>date.getTime()),[(1000000000+1)*1000]);
  await pid(104,400,'/data/installation.json','hidden');
  try{
   assert.deepEqual((await gatewayStartTimes(host,proc)).map(date=>date.getTime()).sort(),[(1000000000+1)*1000,(1000000000+4)*1000]);
  }finally{await chmod(join(root,'fs-104','data'),0o700);}
  // /proc with hidepid hides other users' processes: an empty list would only mean "cannot see", so it is an error.
  await writeFile(join(proc,'self','mountinfo'),mountinfo.replace('proc rw\n','proc rw,hidepid=invisible\n'));
  await assert.rejects(gatewayStartTimes(host,proc),/PROC_HIDEPID/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the default queries keep exactly the entries an open or recent job or planning call is bound to',{skip:!process.env.AC_TEST_DATABASE_URL,timeout:120000},async()=>{
 const fixture=await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!,'retired_sql');
 const ledger=new Ledger(fixture.url);
 try{
  await ledger.migrate();
  const pair=oldPairs[0]!,other=oldPairs[1]!;
  const pairDigest=nativeExecutionExecutorDigest(pair.workerImage,pair.toolsImage),otherDigest=nativeExecutionExecutorDigest(other.workerImage,other.toolsImage);
  const planDigest=nativePlanningExecutorDigest(oldPlanning[0]!),otherPlan=nativePlanningExecutorDigest(oldPlanning[1]!);
  const old="clock_timestamp()-interval '30 days'",recent='clock_timestamp()';
  // Journals without their parents: foreign keys and guard triggers are off for this session only; the CHECKs on states stay.
  const client=await ledger.pool.connect();
  const hex=()=>hash(randomUUID());
  type Job={digest:string;state:string;role?:string;created?:string;retired?:boolean};
  type Call={digest:string;state:string;selected?:boolean;created?:string;job?:string};
  const seed=async(jobs:Job[],calls:Call[])=>{
   for(const table of ['ac_native_terminal_retirements','ac_native_execution_jobs','ac_native_planning_jobs','ac_semantic_planning_calls'])await client.query(`DELETE FROM ${table}`);
   for(const job of jobs){
    const id=randomUUID();
    await client.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,created_at)
     VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,${job.created??old})`,
     [id,randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID(),hex(),job.digest,hex(),hex(),'e'.repeat(40),job.role??'programmer',job.state]);
    if(job.retired)await client.query(`INSERT INTO ac_native_terminal_retirements(job_id,binding,state,proof) VALUES($1,'{}','removed','{}')`,[id]);
   }
   for(const call of calls){
    const id=randomUUID();
    await client.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,state,selected_executor_id,selected_executor_digest,selected_key_fingerprint,created_at)
     VALUES($1,$2,$3,'owner',$4,'native-plan',$5,0,$6,$7,$8,$9,$10,$11,${call.created??old})`,
     [id,randomUUID(),randomUUID(),hex(),call.selected?hex():call.digest,randomUUID(),randomUUID(),call.state,call.selected?'native-plan':null,call.selected?call.digest:null,call.selected?hex():null]);
    if(call.job)await client.query(`INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,state) VALUES($1,$2,$3,$4,$5,$6,$7)`,
     [id,randomUUID(),randomUUID(),hex(),hex(),'plan-'+id,call.job]);
   }
  };
  const kept=async(jobs:Job[],calls:Call[])=>{
   await seed(jobs,calls);
   const env=await installation(fixture.url);
   try{
    await retireNativeImages(env.config,env.file,true,{gatewayStarts:async()=>[]});
    const boot=JSON.parse(await readFile(env.file,'utf8')).nativeBootstrap;
    return {pairs:(boot.execution.retiredImages??[]).length as number,pair:JSON.stringify(boot.execution.retiredImages??[]).includes(pair.workerImage),
     plans:(boot.planning.retiredImageIds??[]) as string[]};
   }finally{await rm(env.root,{recursive:true,force:true});}
  };
  await client.query("SET session_replication_role='replica'");
  try{
   // Execution: unfinished, a terminal job whose containers were not removed, or one created in the quiet window keep the pair.
   for(const job of [{digest:pairDigest,state:'running'},{digest:pairDigest,state:'uncertain'},
    ...['reviewer','judge','qa'].map(role=>({digest:pairDigest,state:'completed',role})),
    {digest:pairDigest,state:'failed',created:recent}]){
    const result=await kept([job],[]);
    assert.equal(result.pair,true,JSON.stringify(job));
    assert.equal(result.pairs,1,JSON.stringify(job));
   }
   // Finished long ago, a reviewer whose containers were removed, or another executor's open job: the pair goes.
   for(const jobs of [[{digest:pairDigest,state:'completed'}],[{digest:pairDigest,state:'failed',role:'reviewer',retired:true}],[{digest:hash('unrelated-executor'),state:'running'}]]){
    assert.equal((await kept(jobs,[])).pairs,0,JSON.stringify(jobs));
   }
   // The other retired pair is judged on its own digest.
   assert.deepEqual(await kept([{digest:otherDigest,state:'running'}],[]).then(result=>[result.pairs,result.pair]),[1,false]);
   // Planning: an open call (by its selected executor or, before the dispatcher, its own), an unfinished planning job under a
   // published call, or a call created in the quiet window keep the image; any other leaves.
   for(const call of [...['registered','ready','uncertain'].map(state=>({digest:planDigest,state,selected:true})),
    {digest:planDigest,state:'registered'},{digest:planDigest,state:'published',selected:true,job:'running'},
    {digest:planDigest,state:'published',selected:true,job:'prepared'},{digest:planDigest,state:'rejected',created:recent}]){
    assert.deepEqual((await kept([],[call])).plans,[oldPlanning[0]],JSON.stringify(call));
   }
   for(const calls of [[{digest:planDigest,state:'published',selected:true,job:'completed'}],[{digest:planDigest,state:'rejected'}],[{digest:planDigest,state:'published'}]]){
    assert.deepEqual((await kept([],calls)).plans,[],JSON.stringify(calls));
   }
   assert.deepEqual((await kept([],[{digest:otherPlan,state:'ready',selected:true}])).plans,[oldPlanning[1]]);
  }finally{
   await client.query("SET session_replication_role='origin'").catch(()=>undefined);
   client.release();
  }
 }finally{await ledger.close();await fixture.close();}
});
