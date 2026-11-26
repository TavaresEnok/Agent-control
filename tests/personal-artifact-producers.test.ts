// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {chmod,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import type {Installation} from '../src/installation.ts';
import {endRound,trackRoundTemp} from '../src/personal-artifact-hooks.ts';
import {runPersonalArtifactRetention,type RetentionDeps} from '../src/personal-artifact-retention.ts';
import {beginPersonalVerification,defaultRunTools,prepareExamSnapshot,readVerificationProgress} from '../src/verify-command.ts';
import {prepareModuleSnapshot,reconcileModuleReports,removeModuleSnapshot,runModuleCollectorContainer,runVerificationModule} from '../src/verification-modules.ts';
import {Capacity} from '../src/capacity.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import type {VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

/**
 * The producers record their own temporaries. Nothing here calls a registration export for the artifacts under test:
 * the real `prepareModuleSnapshot`, `runModuleCollectorContainer`, `runVerificationModule` and `reconcileModuleReports`
 * do it, and the real retention run judges the result. No real deletion outside a throwaway directory.
 */

const HOUR=3600_000;
const databaseUrl=process.env.AC_TEST_DATABASE_URL;
const gitEnv={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',
 GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid'};
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env:gitEnv,encoding:'utf8'}).trim();
const readdirNames=async(path:string)=>(await readdir(path)).filter(name=>name.startsWith('ac-'));
const registryFile=(data:string)=>join(data,'artifact-retention','registry.json');
const readRegistry=async(data:string)=>JSON.parse(await readFile(registryFile(data),'utf8')) as {temps:{path:string;roundId:string}[];rounds:{roundId:string;endedAt:number}[];history:{action:string}[]};

type Lab={base:string;repo:string;data:string;tmp:string;commit:string;projectId:string;config:Installation;deps:(now:number)=>RetentionDeps};
type CollectorProcess=NonNullable<Parameters<typeof runModuleCollectorContainer>[0]['executeProcess']>;
const previousTmpdir=process.env.TMPDIR;

/** Points the system temporary directory at a private folder, so that the real producers create `ac-*` there. */
async function lab():Promise<Lab>{
 const base=realpathSync(await mkdtemp(join(tmpdir(),'artifact-producers-')));
 const repo=join(base,'repo'),data=join(base,'data'),tmp=join(base,'tmp');
 mkdirSync(repo);mkdirSync(data,{mode:0o700});mkdirSync(tmp,{mode:0o700});
 git(repo,'init','-q','-b','main');
 writeFileSync(join(repo,'a.txt'),'a\n');
 git(repo,'add','.');git(repo,'commit','-q','-m','first');
 const projectId=randomUUID();
 process.env.TMPDIR=tmp;
 const config={activation:'personal',dataDirectory:data,databaseUrl:'postgres://invalid.example/none',project:{id:projectId,label:'p',repo,owner:'owner'},projects:[]} as unknown as Installation;
 return {base,repo,data,tmp,commit:git(repo,'rev-parse','HEAD'),projectId,config,
  deps:now=>({now:()=>now,tmpRoot:tmp,productRoot:join(base,'no-product'),sharedRefsRoot:join(base,'shared-refs'),freeBytes:async()=>undefined,processInside:async()=>false,docker:async()=>({code:0,stdout:''}),verifyRunImages:async()=>[]})};
}
const cleanup=async(l:Lab)=>{
 if(previousTmpdir===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmpdir;
 await rm(l.base,{recursive:true,force:true});
};
const retain=(l:Lab,now:number,apply:boolean)=>runPersonalArtifactRetention(l.config,apply,l.deps(now));

test('a module snapshot is recorded by its producer; it is kept until the run is proved ended and 24 h have passed, then removed',async()=>{
 const l=await lab();
 try{
  const snapshot=await prepareModuleSnapshot(l.repo,l.commit,{dataDirectory:l.data,projectId:l.projectId,roundId:'run-a'});
  const t0=Date.now();
  const parent=dirname(snapshot);
  assert.equal(dirname(parent),l.tmp);
  assert.deepEqual((await readRegistry(l.data)).temps.map(item=>[item.path,item.roundId]),[[parent,'run-a']]);
  // The run has not ended: no amount of waiting makes it removable.
  assert.match((await retain(l,t0+100*HOUR,false)).join('\n'),/rodada sem prova de encerramento/);
  assert.ok(existsSync(snapshot));
  assert.equal(await endRound({dataDirectory:l.data,projectId:l.projectId,roundId:'run-a'},{now:()=>t0}),true);
  assert.match((await retain(l,t0+23*HOUR,true)).join('\n'),/rodada encerrada há 23 h \(mínimo 24 h\)/);
  assert.ok(existsSync(snapshot));
  assert.match((await retain(l,t0+25*HOUR,false)).join('\n'),/elegível \(rodada run-a encerrada há 25 h\)/);
  assert.ok(existsSync(snapshot),'the preview removes nothing');
  assert.match((await retain(l,t0+25*HOUR,true)).join('\n'),/removido\./);
  assert.equal(existsSync(parent),false);
  assert.equal((await readRegistry(l.data)).temps.length,0);
 }finally{await cleanup(l);}
});

test('a snapshot removed by the producer leaves only a registry line, which retention drops without touching anything else',async()=>{
 const l=await lab();
 try{
  const snapshot=await prepareModuleSnapshot(l.repo,l.commit,{dataDirectory:l.data,projectId:l.projectId,roundId:'run-b'});
  await removeModuleSnapshot(snapshot);
  const lines=(await retain(l,Date.now(),true)).join('\n');
  assert.match(lines,/o diretório já não existe/);
  assert.equal((await readRegistry(l.data)).temps.length,0);
 }finally{await cleanup(l);}
});

test('a snapshot made without a retention scope, or in a data directory that is not private, is never recorded or removed',async()=>{
 const l=await lab();
 try{
  const plain=await prepareModuleSnapshot(l.repo,l.commit);
  assert.equal(existsSync(registryFile(l.data)),false);
  const open=join(l.base,'open');mkdirSync(open,{mode:0o755});
  assert.equal(await trackRoundTemp({dataDirectory:open,projectId:l.projectId,roundId:'run-c'},dirname(plain)),false,'a data directory open to others is refused');
  assert.equal(existsSync(join(open,'artifact-retention','registry.json')),false);
  // A path outside the temporary root cannot be recorded either, and the producer is not affected.
  assert.equal(await trackRoundTemp({dataDirectory:l.data,projectId:l.projectId,roundId:'run-c'},l.repo),false);
  assert.match((await retain(l,Date.now()+100*HOUR,true)).join('\n'),/1 item\(ns\) ac-\* no diretório temporário sem registro de propriedade: preservado/);
  assert.ok(existsSync(plain));
 }finally{await cleanup(l);}
});

test('the collector container producer records the snapshot and the passive evidence folder while it runs, and nothing remains after it fails',async()=>{
 const l=await lab();
 try{
  const seen:string[][]=[];
  const evidence={schemaVersion:1,collectedBy:'agent-control-prontidao-adapter',collectedAt:'2026-11-20T00:00:00Z',targets:[{origin:'https://example.invalid',status:'ok',httpStatus:200,
   tlsProtocol:'TLSv1.3',cipher:'x',tlsAuthorized:true,tlsErrorCode:null,tlsErrorMessage:null,errorCode:null,errorMessage:null,certificate:null,headers:{},
   redirectTargetOrigin:null,redirectCrossOrigin:false,redirectDowngradeHttp:false,bytesRead:1,truncated:false,durationMs:1}]};
  const failing:CollectorProcess=async()=>{
   seen.push((await readRegistry(l.data)).temps.map(item=>item.path.replace(l.tmp+'/','').replace(/-.{6}$/,'')).sort());
   return {code:1,stdout:Buffer.alloc(0),stderr:'Error response from daemon: No such image'};
  };
  await assert.rejects(runModuleCollectorContainer({image:'sha256:'+'ab'.repeat(32),repoPath:l.repo,commit:l.commit,module:'prontidao',
   passiveTlsEvidence:evidence as never,executeProcess:failing,journal:{} as never,
   retention:{dataDirectory:l.data,projectId:l.projectId,roundId:'run-d'}}));
  assert.deepEqual(seen,[['ac-module-snapshot','ac-prontidao-evidence']]);
  assert.deepEqual((await readdirNames(l.tmp)),[]);
  // Both folders are gone, so the next retention run only drops their registry lines.
  assert.match((await retain(l,Date.now(),true)).at(-1)!,/temporários 2 removido\(s\) e 0 preservado/);
  assert.equal((await readRegistry(l.data)).temps.length,0);
 }finally{await cleanup(l);}
});

test('runVerificationModule ends its round on success, and the next recovery ends the round of an abandoned run',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
 const l=await lab();
 try{
  await withModuleRecoveryFixture(databaseUrl!,async base=>{
   const {ledger,principal,authority,projectId}=base;
   // The fixture creates its data directory with the default mode; the installation's one is private.
   await chmod(base.dataDirectory,0o700);
   const config={...l.config,dataDirectory:base.dataDirectory,project:{id:projectId,label:'p',repo:base.repoPath,owner:principal}} as unknown as Installation;
   const t0=Date.now();
   const collectorOutput={coverage:[{tool:'fixture',version:'1',status:'ok',detail:'synthetic'}],findings:[]};
   const done=await runVerificationModule({...base,collectorOutput});
   const afterRun=await readRegistry(base.dataDirectory);
   assert.deepEqual(afterRun.rounds.map(round=>round.roundId),[done.runId],'a finished run closes its round');
   // The producer removed its own snapshot; retention only drops the registry line.
   assert.match((await runPersonalArtifactRetention(config,true,{...l.deps(t0+2*HOUR),tmpRoot:l.tmp})).join('\n'),/o diretório já não existe/);
   assert.equal((await readRegistry(base.dataDirectory)).temps.length,0);

   // An older manager epoch left a run in "running" with a registered snapshot: the product recovers it as failed.
   const abandoned=randomUUID(),intent=randomUUID(),context=authority.contextId;
   await ledger.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,0)`,[intent,context,principal,'0'.repeat(64),JSON.stringify({payload:{workflow:'security-verify-readonly-v1'}}),randomUUID(),randomUUID(),authority.epoch+100]);
   await ledger.pool.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module)
    VALUES($1,$2,$3,$4,$5,$6,'running','pending','qa')`,[abandoned,projectId,context,intent,principal,base.commit]);
   const snapshot=await prepareModuleSnapshot(base.repoPath,base.commit,{dataDirectory:base.dataDirectory,projectId,roundId:abandoned});
   assert.equal((await readRegistry(base.dataDirectory)).rounds.some(round=>round.roundId===abandoned),false);
   await reconcileModuleReports(ledger,principal,authority,base.dataDirectory,projectId);
   const status=(await ledger.pool.query('SELECT status FROM ac_verify_runs WHERE id=$1',[abandoned])).rows[0].status;
   assert.equal(status,'failed');
   const registry=await readRegistry(base.dataDirectory);
   assert.ok(registry.rounds.some(round=>round.roundId===abandoned),'the proven end of the abandoned run closes its round');
   const closedAt=registry.rounds.find(round=>round.roundId===abandoned)!.endedAt;
   assert.match((await runPersonalArtifactRetention(config,true,{...l.deps(closedAt+HOUR),tmpRoot:l.tmp})).join('\n'),/rodada encerrada há 1 h \(mínimo 24 h\)/);
   assert.ok(existsSync(snapshot));
   assert.match((await runPersonalArtifactRetention(config,true,{...l.deps(closedAt+25*HOUR),tmpRoot:l.tmp})).join('\n'),/removido\./);
   assert.equal(existsSync(dirname(snapshot)),false);
  });
 }finally{await cleanup(l);}
});

test('the personal exam snapshot is recorded by its producer while the tools run, and the folder is gone when they end',async()=>{
 const l=await lab();
 try{
  const output=join(l.base,'out'),databases=join(l.base,'db');mkdirSync(output,{mode:0o700});mkdirSync(databases);
  const scope={dataDirectory:l.data,projectId:l.projectId,roundId:'exam-a'};
  const seen:{recorded:string[];mounted:string}[]=[];
  await defaultRunTools({image:'sha256:'+'ab'.repeat(32),repository:l.repo,databases,output,commit:l.commit,staticPersonalExam:true,retention:scope},5_000,async args=>{
   const mount=args.find(item=>item.startsWith('type=bind,src=')&&item.includes(',dst=/repository,readonly'))!;
   const mounted=mount.slice('type=bind,src='.length).split(',')[0]!;
   seen.push({recorded:(await readRegistry(l.data)).temps.map(item=>item.path),mounted});
   // The owner marker lives in the private parent, never in the mounted checkout that the exam reads.
   assert.ok(existsSync(join(dirname(mounted),'.ac-retention-owner')));
   assert.equal(existsSync(join(mounted,'.ac-retention-owner')),false);
  });
  assert.equal(seen.length,1);
  assert.deepEqual(seen[0]!.recorded,[dirname(seen[0]!.mounted)]);
  assert.equal(dirname(dirname(seen[0]!.mounted)),l.tmp);
  assert.deepEqual(await readdirNames(l.tmp),[]);
  assert.match((await retain(l,Date.now(),true)).join('\n'),/o diretório já não existe/);
  // The non-static snapshot is the mounted checkout itself, so no marker may enter it: it is not recorded.
  const plain=await prepareExamSnapshot(l.repo,l.commit,false,scope);
  assert.equal(existsSync(join(plain,'.ac-retention-owner')),false);
  assert.equal((await readRegistry(l.data)).temps.length,0);
  await rm(plain,{recursive:true,force:true});
 }finally{await cleanup(l);}
});

const examWorker:VerifyWorker={async run(call){
 const task=call.task;
 if(task.startsWith('Pedido de mapa.'))return JSON.stringify({kind:'mapa',routes:[{method:'GET',path:'/admin',file:'src/app.ts',line:2}],surfaces:['http']});
 throw new Error('stop after the map');
}};

test('an exam job ends its round when it finishes, and a snapshot left behind then ages out',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset',timeout:180_000},async()=>{
 const l=await lab();
 const database=databaseUrl?await isolatedDatabase(databaseUrl,'artexam'):undefined;
 const db=new Ledger(database!.url);
 const databases=join(l.base,'bases');mkdirSync(databases);
 try{
  await db.migrate();
  const capacity=new Capacity(db),principal='verify-owner',project=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Verificação']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:10,evaluationLimit:2});
  await capacity.registerModel(principal,{provider:'claude',model:'fixture-model',efforts:['medium'],roles:['specialist','reviewer'],source:'synthetic://artifact-producers'});
  const accounts=[randomUUID(),randomUUID()],specialists=[randomUUID(),randomUUID()],reviewers=[randomUUID(),randomUUID()];
  const adapters=accounts.map((_,i)=>createSyntheticProviderAdapter({id:'fixture-art-'+i,provider:'claude',version:'verify-v1',
   runner:async input=>({protocol:'ac-synthetic-quota-v1',provider:'claude',accountId:input.accountId,status:'available',remainingPercent:75,resetAt:null})}));
  const collectors=new ProviderCollectors(db,adapters);
  for(let i=0;i<accounts.length;i++){
   await capacity.addAccount(principal,project,{id:accounts[i]!,provider:'claude',label:'Synthetic '+i,resourceIdentity:'artifact-'+accounts[i],mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://artifact-producers',maxConcurrent:2});
   await capacity.addProfile(principal,project,{id:specialists[i]!,accountId:accounts[i]!,model:'fixture-model',effort:'medium',role:'specialist'});
   await capacity.addProfile(principal,project,{id:reviewers[i]!,accountId:accounts[i]!,model:'fixture-model',effort:'medium',role:'reviewer'});
   await collectors.bind(principal,project,{accountId:accounts[i]!,adapterId:adapters[i]!.manifest.id,expectedRevision:0,minimumIntervalSeconds:1});
  }
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,
   roles:{specialist:{regular:specialists,emergency:[]},reviewer:{regular:reviewers,emergency:[]}}});
  const context=await db.createContext(principal,project,randomUUID());
  await capacity.assignPolicy(principal,context,revision);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");
  for(const accountId of accounts)await collectors.collect(principal,project,accountId,randomUUID());
  const authority=await db.acquire(principal,context,randomUUID(),'verify-command',60);
  let observed:Promise<void>|undefined,scope:{dataDirectory:string;projectId:string;roundId:string}|undefined,left='';
  const begun=await beginPersonalVerification({projectId:project,url:'http://127.0.0.1:9/app',dataDirectory:l.data,repoPath:l.repo,commit:l.commit,ledger:db,principal,authority,
   policyRevision:1,worker:examWorker,databasesDirectory:databases,image:'sha256:'+'ab'.repeat(32),modelCalls:{count:0},
   networkRunner:async()=>({code:0,stdout:'true'}),
   // The tool run receives the round scope from the job; it leaves its snapshot behind, as a crash would.
   runTools:async spec=>{
    scope=spec.retention;
    left=await prepareExamSnapshot(spec.repository,l.commit,true,spec.retention);
   },
   observe:job=>{observed=job;}});
  await observed!.catch(()=>undefined);
  assert.deepEqual(scope,{dataDirectory:l.data,projectId:project,roundId:begun.id});
  assert.ok(existsSync(left));
  const registry=await readRegistry(l.data);
  assert.deepEqual(registry.temps.map(item=>[item.path,item.roundId]),[[left,begun.id]]);
  const ended=registry.rounds.find(round=>round.roundId===begun.id);
  assert.ok(ended,'a finished job closes its round');
  const config={...l.config,dataDirectory:l.data,project:{id:project,label:'p',repo:l.repo,owner:principal}} as unknown as Installation;
  assert.match((await runPersonalArtifactRetention(config,true,{...l.deps(ended.endedAt+HOUR),tmpRoot:l.tmp})).join('\n'),/rodada encerrada há 1 h \(mínimo 24 h\)/);
  assert.ok(existsSync(left));
  assert.match((await runPersonalArtifactRetention(config,true,{...l.deps(ended.endedAt+25*HOUR),tmpRoot:l.tmp})).join('\n'),/removido\./);
  assert.equal(existsSync(left),false);
  assert.equal((await readVerificationProgress(l.data,project))[0]?.id,begun.id);
 }finally{
  await db.close();await database?.close();await cleanup(l);
 }
});

test('a round that recorded no temporary is not written down, so the registry does not grow with every run',async()=>{
 const l=await lab();
 try{
  const scope={dataDirectory:l.data,projectId:l.projectId,roundId:'run-empty'};
  assert.equal(await endRound(scope),false);
  assert.equal(existsSync(join(l.data,'artifact-retention')),false);
  const snapshot=await prepareModuleSnapshot(l.repo,l.commit,scope);
  assert.equal(await endRound({...scope,roundId:'run-other'}),false,'another round of the same project has nothing to close');
  assert.equal(await endRound(scope),true);
  assert.deepEqual((await readRegistry(l.data)).rounds.map(item=>item.roundId),['run-empty']);
  await removeModuleSnapshot(snapshot);
 }finally{await cleanup(l);}
});
