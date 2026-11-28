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
