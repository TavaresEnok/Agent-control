import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionRequest,NativeExecutionSupervisor,terminalWorkClass} from '../src/native-execution-supervisor.ts';
import {runPersonalJobRetention,runPersonalMaintenance} from '../src/personal-maintenance.ts';
import {inventoryJobWork,pinRetainedArtifact,readRetentionCursor,repositoryHasCommit,repositoryKeepsArtifact,retainedArtifact,rotateAfter,workHoldsNoUnregisteredChange,writeRetentionCursor} from '../src/native-work-retention.ts';
import {Refusal,canonical,digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exists=(path:string)=>lstat(path).then(()=>true,()=>false);

test('automatic retention accepts only its own usage',async()=>{
 const usage=async(...args:string[])=>runPersonalMaintenance(['/nonexistent/installation.json',...args]).then(()=>'ok',error=>error instanceof Refusal?error.code:String(error));
 for(const args of [['--retencao-automatica','--tudo'],['--retencao-automatica','--aplicar','--aplicar'],['--retencao-automatica','--projeto','x'],['--retencao-automatica','extra','--aplicar']])
  assert.equal(await usage(...args),'MAINTENANCE_USAGE',args.join(' '));
 assert.notEqual(await usage('--retencao-automatica'),'MAINTENANCE_USAGE');
 assert.notEqual(await usage('--retencao-automatica','--aplicar'),'MAINTENANCE_USAGE');
});

test('the inventory is one pass over the job root and the cursor makes runs round-robin',async()=>{
 const area=await mkdtemp(join(tmpdir(),'ac-inventory-'));
 try{
  const root=join(area,'root');await mkdir(root,{mode:0o700});await chmod(root,0o700);
  const withWork=[randomUUID(),randomUUID(),randomUUID()],withReviewOnly=randomUUID(),without=[randomUUID(),randomUUID()];
  for(const id of [...withWork,withReviewOnly,...without]){await mkdir(join(root,id));await mkdir(join(root,id,'output'));}
  for(const id of withWork)await mkdir(join(root,id,'work'));
  await mkdir(join(root,withReviewOnly,'review-artifact'));
  await writeFile(join(root,without[0]!,'work.log'),'not work');
  await mkdir(join(root,'not-a-job','work'),{recursive:true});await writeFile(join(root,'stray-file'),'x');
  await symlink(join(root,withWork[0]!),join(root,randomUUID()));
  const found=await inventoryJobWork(root);
  assert.deepEqual(found.ids,[...withWork,withReviewOnly].sort());
  assert.equal(found.scanned,6);
  await chmod(root,0o755);await assert.rejects(inventoryJobWork(root),/Unsafe job directory/);
  assert.deepEqual(rotateAfter(['a','b','c','d'],undefined),['a','b','c','d']);
  assert.deepEqual(rotateAfter(['a','b','c','d'],'b'),['c','d','a','b']);
  assert.deepEqual(rotateAfter(['a','b','c','d'],'d'),['a','b','c','d']);
  assert.deepEqual(rotateAfter(['a','b'],'bb'),['a','b']);
  const cursor=join(area,'cursor.json'),id=randomUUID();
  assert.equal(await readRetentionCursor(cursor),undefined);
  await writeRetentionCursor(cursor,id);assert.equal(await readRetentionCursor(cursor),id);
  await writeRetentionCursor(cursor,undefined);assert.equal(await readRetentionCursor(cursor),undefined);
  await writeFile(cursor,'{broken');assert.equal(await readRetentionCursor(cursor),undefined);
  await writeFile(cursor,JSON.stringify({after:'../../etc'}));assert.equal(await readRetentionCursor(cursor),undefined);
 }finally{await rm(area,{recursive:true,force:true});}
});

test('repository proofs: a commit must exist, and an artifact must hang from a ref',async()=>{
 const area=await mkdtemp(join(tmpdir(),'ac-repoproof-'));
 try{
  const repo=join(area,'repo');execFileSync('git',['init','-q',repo]);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
  await writeFile(join(repo,'a.txt'),'a');git('add','.');git('commit','-qm','base');
  const base=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
  assert.equal(await repositoryHasCommit(repo,base),true);
  assert.equal(await repositoryHasCommit(repo,'e'.repeat(40)),false);
  assert.equal(await repositoryHasCommit(repo,'--all'),false);
  assert.equal(await repositoryKeepsArtifact(repo,base,tree),true);
  assert.equal(await repositoryKeepsArtifact(repo,base,'e'.repeat(40)),false);
  // An imported but unreferenced commit is still at the mercy of garbage collection.
  const loose=git('commit-tree',tree,'-p',base,'-m','loose');
  assert.equal(await repositoryHasCommit(repo,loose),true);
  assert.equal(await repositoryKeepsArtifact(repo,loose,tree),false);
  git('update-ref','refs/agent-control/keep',loose);
  assert.equal(await repositoryKeepsArtifact(repo,loose,tree),true);
  assert.equal(await repositoryKeepsArtifact(join(area,'missing'),loose,tree),false);
  // The private ref of a job: created once by CAS, replay with the same value is accepted, any other value is refused.
  const job=randomUUID(),other=git('commit-tree',tree,'-p',base,'-m','other');
  assert.equal(await retainedArtifact(repo,job),undefined);
  assert.equal(await pinRetainedArtifact(repo,job,loose,'e'.repeat(40)),'missing');
  assert.equal(await pinRetainedArtifact(repo,job,'e'.repeat(40),tree),'missing');
  assert.equal(await pinRetainedArtifact(repo,job,loose,tree),'created');
  assert.equal(await pinRetainedArtifact(repo,job,loose,tree),'kept');
  assert.equal(await pinRetainedArtifact(repo,job,other,tree),'conflict');
  assert.equal(await retainedArtifact(repo,job),loose);
  assert.equal(git('rev-parse','refs/agent-control/retained/'+job),loose);
  // Concurrent pins of different commits: exactly one wins, the ref is never moved afterwards.
  const raced=randomUUID();
  const outcomes=await Promise.all([pinRetainedArtifact(repo,raced,loose,tree),pinRetainedArtifact(repo,raced,other,tree)]);
  assert.deepEqual([...outcomes].sort(),['conflict','created']);
  assert.equal(await retainedArtifact(repo,raced),outcomes[0]==='created'?loose:other);
  // A hook in the repository never runs, even the reference-transaction hook update-ref would call.
  await mkdir(join(repo,'.git','hooks'),{recursive:true});
  await writeFile(join(repo,'.git','hooks','reference-transaction'),'#!/bin/sh\ntouch '+join(area,'hook-ran')+'\n',{mode:0o755});
  assert.equal(await pinRetainedArtifact(repo,randomUUID(),loose,tree),'created');
  assert.equal(await exists(join(area,'hook-ran')),false);

  // A checkout holds no unregistered change only when its tree and its object store are both covered by the repository.
  const work=join(area,'work');
  execFileSync('git',['clone','-q','--no-local',repo,work]);
  const inWork=(...args:string[])=>execFileSync('git',['-c','user.name=F','-c','user.email=f@invalid','-C',work,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),true);
  inWork('rm','--cached','-q','a.txt');
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),false,'staged deletion is preserved even with an unchanged working file');
  inWork('reset','-q','HEAD','--','a.txt');
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,'e'.repeat(40)),false);
  await writeFile(join(work,'a.txt'),'changed');
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),false);
  inWork('checkout','-q','--','a.txt');
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),true);
  // The checkout's own configuration never runs: a filter or fsmonitor it declares is ignored.
  inWork('config','core.fsmonitor','touch '+join(area,'fsmonitor-ran'));
  inWork('config','filter.evil.clean','touch '+join(area,'filter-ran'));
  await writeFile(join(work,'.git','info','attributes'),'* filter=evil\n');
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),true);
  assert.equal(await exists(join(area,'fsmonitor-ran')),false);assert.equal(await exists(join(area,'filter-ran')),false);
  await writeFile(join(work,'new.txt'),'x');
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),false);
  await rm(join(work,'new.txt'));
  inWork('commit','-q','--allow-empty','-m','only here');inWork('reset','-q','--hard','HEAD~1');
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),false,'a commit only the checkout knows is a change');
  await rm(join(work,'.git'),{recursive:true});
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),false,'no object store: no proof');
 }finally{await rm(area,{recursive:true,force:true});}
});

test('a prova do programador compara bytes mesmo quando atributos normalizam CRLF',async()=>{
 const area=await mkdtemp(join(tmpdir(),'ac-raw-proof-'));
 try{
  const repo=join(area,'repo'),work=join(area,'work');await mkdir(repo);
  const git=(...args:string[])=>execFileSync('git',['-c','user.name=F','-c','user.email=f@invalid','-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q');await writeFile(join(repo,'.gitattributes'),'a.txt text\n');await writeFile(join(repo,'a.txt'),'one\ntwo\n');git('add','.');git('commit','-qm','base');
  const tree=git('rev-parse','HEAD^{tree}');execFileSync('git',['clone','-q','--no-local',repo,work]);
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),true);
  await writeFile(join(work,'a.txt'),'one\r\ntwo\r\n');
  assert.equal(await workHoldsNoUnregisteredChange(repo,work,tree),false);
 }finally{await rm(area,{recursive:true,force:true});}
});

test('the classification of read-only and programmer work is explicit',()=>{
 for(const [workflow,role] of [['engineering-native-v1','qa'],['engineering-native-v1','reviewer'],['engineering-native-v1','judge'],['managed-synthetic-v1','qa'],
  ['baseline-synthetic-v1','judge'],['design-readonly-v1','specialist'],['design-readonly-v1','reviewer'],['security-verify-readonly-v1','specialist'],['security-verify-readonly-v1','reviewer']])
  assert.equal(terminalWorkClass(workflow,role),'readonly',workflow+' '+role);
 for(const workflow of ['engineering-native-v1','engineering-synthetic-v1','managed-synthetic-v1','baseline-synthetic-v1'])assert.equal(terminalWorkClass(workflow,'programmer'),'programmer');
 for(const [workflow,role] of [['engineering-native-v1','specialist'],['design-readonly-v1','programmer'],['security-verify-readonly-v1','qa'],['semantic-proposal-v1','qa'],
  ['remote-development-session-v1','reviewer'],['constructor','qa'],['__proto__','qa'],[undefined,'qa'],['engineering-native-v1',undefined]])
  assert.equal(terminalWorkClass(workflow,role),undefined,String(workflow)+' '+String(role));
});

test('automatic job retention frees only proven categories, with the gateway running, concurrently and repeatably',{skip:!process.env.AC_TEST_DATABASE_URL},async t=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'jobret');
 const db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-jobret-'));
 try{
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const capacity=new Capacity(db);
  const project=randomUUID(),owner='app-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'exec-host'),accounts=join(area,'accounts'),outside=join(area,'outside'),data=join(area,'data');
  for(const dir of [spool,accounts,outside,data]){await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);}
  await writeFile(join(outside,'precious.txt'),'must survive');
  execFileSync('git',['init','-q',repo]);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
  await writeFile(join(repo,'a.txt'),'a');git('add','.');git('commit','-qm','base');
  const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
  const image='sha256:'+'0'.repeat(64),providerNetwork='d'.repeat(64);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Job retention fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,owner]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const subject=digest({provider:'claude',subject:'job-retention-fixture'});
  await capacity.addAccount(owner,project,{id:account,provider:'claude',label:'job retention fixture',resourceIdentity:'claude:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:2});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'claude-sonnet-5-5','medium','specialist',true)",[profile,account]);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),owner]);
  await db.pool.query("INSERT INTO ac_quality_policies(project_id,revision,snapshot,digest) VALUES($1,1,'{}',$2)",[project,'c'.repeat(64)]);
  const keys=generateKeyPairSync('ed25519');
  const pem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  const keyFile=join(area,'execution.key');await writeFile(keyFile,pem,{mode:0o600});
  const supervisor=new NativeExecutionSupervisor(db,{id:'personal-execution-claude',provider:'claude',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:pem,providerNetworkId:providerNetwork,workerEnv:[],toolsEnv:[],accountSubjects:[{accountId:account,subjectDigest:subject}]},{assertAdmission:async()=>{}});
  const profileDigest=digest({accountId:account,profileId:profile,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  const hex=(label:string)=>createHash('sha256').update(label).digest('hex');
  const signWith=(domain:string,payload:unknown)=>sign(null,Buffer.from(domain+canonical(payload)),keys.privateKey).toString('hex');

  type Role='specialist'|'reviewer'|'qa'|'judge'|'programmer';
  type Plant={role?:Role;workflow?:string;state?:'completed'|'failed';retirement?:'removed'|'none';base?:string;
   artifact?:'registered'|'unregistered'|'conflict';managed?:boolean;writerRevoked?:boolean;work?:'tree'|'none';grantState?:string;
   change?:'modified'|'untracked'|'ignored'|'commit'|'stash';request?:'good'|'tampered'|'missing';launched?:boolean;started?:boolean;checkout?:'good'|'added'|'no-identity'|'replaced'|'forged'|'other-base'};
  const intoWork=(work:string,...args:string[])=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@invalid','-C',work,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  const plant=async(o:Plant={})=>{
   const role=o.role??'specialist',state=o.state??'completed',failed=state==='failed',programmer=role==='programmer';
   const contextId=await db.createContext(owner,project,randomUUID());
   const intentId=randomUUID(),jobId=randomUUID(),grantId=randomUUID(),sessionId=randomUUID(),runId=randomUUID();
   const workflow=o.workflow??(role==='specialist'?'security-verify-readonly-v1':'baseline-synthetic-v1');
   const command={schemaVersion:1 as const,intentId,deliveryAttemptId:randomUUID(),contextId,policyRevision:0,action:'plan.start' as const,payload:{workflow,messageRef:`qa:${project}:${commit}`,projectId:project,commit}};
   let parent:string|null=null;
   if(o.managed){
    parent=randomUUID();
    await db.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,1,0)`,
     [parent,contextId,owner,digest({parent}),JSON.stringify({...command,intentId:parent,payload:{workflow:'managed-synthetic-v1',messageRef:'m'}}),randomUUID(),randomUUID()]);
   }
   await db.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,1,0,$8,$9)`,
    [intentId,contextId,owner,digest(command),JSON.stringify(command),randomUUID(),runId,parent,parent?'unit-1':null]);
   const workerId=hex('w'+jobId),toolsId=hex('t'+jobId),networkId=hex('n'+jobId);
   const baseId=o.base??commit;
   // The signed request is what proves the mount mode: its digest is bound to the job row and to the receipt.
   const request=NativeExecutionRequest.parse({jobId,intentId,grantId,sessionId,base:baseId,role,task:'fixture task',writePaths:programmer?['src']:[],...(programmer?{}:{artifactId:randomUUID(),outputSchema:{type:'object'}})});
   const inputDigest=digest(request);
   const code=failed?1:0;
   const physical={jobId,containerId:workerId,toolsContainerId:toolsId,networkId,exitCode:code,workerExitCode:code,finishedAt:'2026-11-20T01:00:00Z',toolsFinishedAt:'2026-11-20T01:00:01Z'};
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,1,1,$9,false,$10,$11)`,[grantId,randomUUID(),intentId,contextId,account,profile,role,project,digest({grantId}),o.grantState??'released',physical]);
   const root=join(spool,jobId),work=join(root,'work');
   await mkdir(root,{mode:0o700});await chmod(root,0o700);
   let artifact:null|{commit:string;tree:string;base:string}=null;
   if(programmer&&o.work!=='none'){
    // A real checkout, as the snapshot helper leaves it: a clone of the project at the base.
    execFileSync('git',['clone','-q','--no-local',repo,work],{stdio:'ignore'});
    if(!failed){
     await writeFile(join(work,'src-'+jobId+'.ts'),'export const job = 1;\n');
     intoWork(work,'add','-A');intoWork(work,'commit','-qm','artifact '+jobId);
     const own=intoWork(work,'rev-parse','HEAD');
     artifact={commit:own,tree:intoWork(work,'rev-parse','HEAD^{tree}'),base:baseId};
     // Import as registerArtifact does: the object reaches the repository without any ref.
     if(o.artifact==='registered'||o.artifact==='conflict')git('fetch','-q',work,'HEAD');
     if(o.artifact==='conflict')git('update-ref','refs/agent-control/retained/'+jobId,commit);
    }
    if(o.change==='modified')await writeFile(join(work,'a.txt'),'edited outside the artifact');
    if(o.change==='untracked')await writeFile(join(work,'notes.txt'),'never committed');
    if(o.change==='ignored'){await writeFile(join(work,'.git','info','exclude'),'*.log\n');await writeFile(join(work,'debug.log'),'ignored but unregistered');}
    if(o.change==='commit'){await writeFile(join(work,'a.txt'),'local');intoWork(work,'commit','-qam','local only');intoWork(work,'reset','-q','--hard','HEAD~1');}
    if(o.change==='stash'){await writeFile(join(work,'a.txt'),'stashed');intoWork(work,'stash','-q');}
   }
   if(!programmer&&o.checkout){
    // An evaluator checkout as launch leaves it: the base snapshot plus a signed identity of that very directory.
    execFileSync('git',['clone','-q','--no-local',repo,work],{stdio:'ignore'});
    const st=await lstat(work,{bigint:true});
    const identity={jobId,base:o.checkout==='other-base'?'f'.repeat(40):baseId,tree,dev:String(st.dev),ino:String(st.ino)};
    if(o.checkout!=='no-identity')await writeFile(join(root,'checkout-identity.json'),JSON.stringify({payload:identity,signature:o.checkout==='forged'?'0'.repeat(128):signWith('agent-control:native-checkout-identity:v1\n',identity)}),{mode:0o600});
    if(o.checkout==='added')await writeFile(join(work,'planted-by-host.txt'),'added before the first inspection');
    if(o.checkout==='replaced'){execFileSync('git',['clone','-q','--no-local',repo,work+'.new'],{stdio:'ignore'});await rm(work,{recursive:true});await rename(work+'.new',work);}
   }
   const payload={schemaVersion:1,accountId:account,profileId:profile,profileDigest,jobId,intentId,contextId,grantId,sessionId,epoch:1,inputDigest,executorDigest:supervisor.executorDigest,outputDigest:digest(''),physicalDigest:digest(physical),workerExitCode:code,artifact,exitCode:code,...(o.started===false?{executionStarted:false}:{})};
   const receipt={payload,signature:signWith('agent-control:native-execution-receipt:v1\n',payload)};
   await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,network_id,worker_id,tools_id,launch_digest,receipt)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [jobId,grantId,intentId,contextId,sessionId,account,profile,profileDigest,supervisor.executorDigest,fingerprint,inputDigest,baseId,role,state,networkId,workerId,toolsId,o.launched===false?null:hex('l'+jobId),receipt]);
   if(artifact&&(o.artifact==='registered'||o.artifact==='conflict'))
    await db.pool.query(`INSERT INTO ac_artifacts VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,'low')`,[randomUUID(),contextId,intentId,grantId,sessionId,project,artifact.commit,artifact.tree,artifact.base,digest(artifact)]);
   const managedWriter=programmer&&o.managed;
   if((o.retirement??'removed')==='removed'&&!managedWriter){
    const binding={schemaVersion:1,jobId,contextId,intentId,grantId,sessionId,epoch:1,role,inputDigest,terminalDigest:digest(receipt),workerId,toolsId,networkId,workerLogSha256:hex('wl'),toolsLogSha256:hex('tl')};
    await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[jobId,binding]);
    await db.pool.query("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1",[jobId,{payload:binding,signature:signWith('agent-control:native-terminal-retirement:v1\n',binding)}]);
   }
   if(managedWriter&&o.writerRevoked){
    const proofPayload={schemaVersion:1,kind:'native-container-pair-removed',jobId,contextId,grantId,attemptId:randomUUID(),parentIntentId:parent,runId,holderIntentId:intentId,writerEpoch:1,workerId,toolsId,terminalDigest:digest(receipt),workerLogSha256:hex('wl'),toolsLogSha256:hex('tl')};
    const proof={payload:proofPayload,signature:signWith('agent-control:native-writer-retirement:v1\n',proofPayload)};
    await db.pool.query("INSERT INTO ac_worktree_writers(parent_intent_id,run_id,holder_intent_id,manager_epoch,state,proof_digest,revocation_job_id,revocation_proof) VALUES($1,$2,$3,1,'neutralized',$4,$5,$6)",[parent,runId,intentId,digest(proof),jobId,proof]);
    await db.pool.query(`INSERT INTO ac_native_writer_retirements(job_id,parent_intent_id,run_id,holder_intent_id,writer_epoch,worker_id,tools_id,terminal_digest,worker_log_sha256,tools_log_sha256,state,proof)
     VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,'revoked',$10)`,[jobId,parent,runId,intentId,workerId,toolsId,digest(receipt),hex('wl'),hex('tl'),proof]);
   }
   for(const dir of ['input','output','planning','review-artifact'])await mkdir(join(root,dir),{mode:0o700});
   await writeFile(join(root,'output','execution-result.json'),JSON.stringify({schemaVersion:1,jobId,output:'',exitCode:code,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:failed?'synthetic_failure':null}),{mode:0o600});
   if(o.request!=='missing')await writeFile(join(root,'request.json'),JSON.stringify(o.request==='tampered'?{...request,task:'another task'}:request),{mode:0o600});
   await writeFile(join(root,'review-artifact','a.txt'),'artifact');
   await writeFile(join(root,'review-artifact','copy.ts'),'r'.repeat(600));
   await symlink(outside,join(root,'review-artifact','link-out'));
   await writeFile(join(root,'worker-terminal.log'),'log');
   if(!programmer&&o.work!=='none'&&!o.checkout){
    await mkdir(join(work,'src'),{recursive:true});await writeFile(join(work,'src','index.ts'),'x'.repeat(1000));
    await mkdir(join(work,'.git'));await writeFile(join(work,'.git','HEAD'),'ref');
    await symlink(outside,join(work,'link-out'));await symlink(join(outside,'precious.txt'),join(work,'link-file'));
   }
   return {jobId,contextId,root,work,intentId,grantId,sessionId,receipt,request,artifact};
  };
  type Planted=Awaited<ReturnType<typeof plant>>;
  const intact=async(p:Planted,reviewKept=false)=>{
   for(const name of ['input','output','planning'])assert.ok(await exists(join(p.root,name)),name+' kept');
   assert.equal(await exists(join(p.root,'review-artifact')),reviewKept,'review-artifact');
   if(reviewKept&&(await lstat(join(p.root,'review-artifact'))).isDirectory())assert.equal(await readFile(join(p.root,'review-artifact','a.txt'),'utf8'),'artifact');
   assert.equal(JSON.parse(await readFile(join(p.root,'output','execution-result.json'),'utf8')).jobId,p.jobId);
   if(await exists(join(p.root,'request.json')))assert.equal(JSON.parse(await readFile(join(p.root,'request.json'),'utf8')).jobId,p.jobId);
   assert.equal(await readFile(join(p.root,'worker-terminal.log'),'utf8'),'log');
  };
  const outsideIntact=async()=>assert.equal(await readFile(join(outside,'precious.txt'),'utf8'),'must survive');
  const audits=async(jobId:string,kind='native.exam_work_released')=>(await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind=$1 AND detail->>'jobId'=$2",[kind,jobId])).rows[0].n as number;
  const journal=async()=>JSON.stringify((await db.pool.query('SELECT job_id,state,binding,proof FROM ac_native_terminal_retirements ORDER BY job_id')).rows)+JSON.stringify((await db.pool.query('SELECT id,state,receipt FROM ac_native_execution_jobs ORDER BY id')).rows);
  const scope=(p:Planted)=>({contextId:p.contextId,projectId:project,repository:repo});
  const retire=(p:Planted,apply:boolean,by=supervisor)=>by.retireTerminalWork(owner,p.jobId,apply,scope(p));
  const retained=(p:Planted)=>execFileSync('git',['-C',repo,'for-each-ref','--format=%(objectname)','refs/agent-control/retained/'+p.jobId],{encoding:'utf8'}).trim();

  // 1. Explicit classification and the proofs of each category, one job each. Nothing but the literal work child is removed.
  const cases:{label:string;o:Plant;expect:string}[]=[
   {label:'passive exam',o:{},expect:'released:passive-exam'},
   {label:'failed passive exam',o:{state:'failed'},expect:'released:passive-exam'},
   {label:'reviewer with its base commit kept',o:{role:'reviewer',checkout:'good'},expect:'released:readonly-evaluator'},
   {label:'qa, failed',o:{role:'qa',state:'failed',checkout:'good'},expect:'released:readonly-evaluator'},
   {label:'judge',o:{role:'judge',checkout:'good'},expect:'released:readonly-evaluator'},
   {label:'reviewer checkout bound to its launch identity',o:{role:'reviewer',checkout:'good'},expect:'released:readonly-evaluator'},
   {label:'reviewer checkout with host content added',o:{role:'reviewer',checkout:'added'},expect:'refused:unregistered_change'},
   {label:'reviewer checkout without identity',o:{role:'reviewer',checkout:'no-identity'},expect:'refused:unregistered_change'},
   {label:'reviewer checkout replaced after launch',o:{role:'reviewer',checkout:'replaced'},expect:'refused:unregistered_change'},
   {label:'reviewer identity with a forged signature',o:{role:'reviewer',checkout:'forged'},expect:'refused:unregistered_change'},
   {label:'reviewer identity for another base',o:{role:'reviewer',checkout:'other-base'},expect:'refused:unregistered_change'},
   {label:'qa of an engineering run',o:{role:'qa',workflow:'engineering-native-v1',checkout:'good'},expect:'released:readonly-evaluator'},
   {label:'design create specialist',o:{workflow:'design-readonly-v1',checkout:'good'},expect:'released:readonly-evaluator'},
   {label:'managed child reviewer: no generic parent rule, same proofs',o:{role:'reviewer',managed:true,workflow:'engineering-native-v1',checkout:'good'},expect:'released:readonly-evaluator'},
   {label:'specialist advising an engineering run is not classified',o:{workflow:'engineering-native-v1'},expect:'refused:unclassified'},
   {label:'qa of an unknown workflow is not classified',o:{role:'qa',workflow:'remote-development-session-v1'},expect:'refused:unclassified'},
   {label:'request no longer matches its digest',o:{role:'reviewer',request:'tampered'},expect:'refused:mode_unproven'},
   {label:'request missing',o:{role:'reviewer',request:'missing'},expect:'refused:mode_unproven'},
   {label:'never launched: no proven checkout',o:{role:'reviewer',launched:false},expect:'refused:mode_unproven'},
   {label:'never started: kept',o:{role:'reviewer',started:false},expect:'refused:receipt'},
   {label:'reviewer whose base commit is gone',o:{role:'reviewer',base:'e'.repeat(40)},expect:'refused:base_unpreserved'},
   {label:'reviewer without a removed retirement',o:{role:'reviewer',retirement:'none'},expect:'refused:retirement'},
   {label:'programmer, artifact registered: pinned by its private ref',o:{role:'programmer',artifact:'registered'},expect:'released:programmer-artifact'},
   {label:'programmer, artifact never registered',o:{role:'programmer',artifact:'unregistered'},expect:'refused:artifact_unpreserved'},
   {label:'programmer, private ref already points elsewhere',o:{role:'programmer',artifact:'conflict'},expect:'refused:artifact_unpreserved'},
   {label:'programmer without physical terminality',o:{role:'programmer',artifact:'registered',retirement:'none'},expect:'refused:retirement'},
   {label:'programmer, edit outside the artifact',o:{role:'programmer',artifact:'registered',change:'modified'},expect:'refused:unregistered_change'},
   {label:'programmer, untracked file',o:{role:'programmer',artifact:'registered',change:'untracked'},expect:'refused:unregistered_change'},
   {label:'programmer, ignored file',o:{role:'programmer',artifact:'registered',change:'ignored'},expect:'refused:unregistered_change'},
   {label:'programmer, local commit only in its reflog',o:{role:'programmer',artifact:'registered',change:'commit'},expect:'refused:unregistered_change'},
   {label:'programmer, stash',o:{role:'programmer',artifact:'registered',change:'stash'},expect:'refused:unregistered_change'},
   {label:'programmer, failed with a clean checkout',o:{role:'programmer',state:'failed'},expect:'released:programmer-artifact'},
   {label:'programmer, failed with local changes',o:{role:'programmer',state:'failed',change:'modified'},expect:'refused:unregistered_change'},
   {label:'programmer, failed with an untracked file',o:{role:'programmer',state:'failed',change:'untracked'},expect:'refused:unregistered_change'},
   {label:'managed programmer with its signed writer revocation',o:{role:'programmer',artifact:'registered',managed:true,writerRevoked:true,workflow:'engineering-native-v1'},expect:'released:programmer-artifact'},
   {label:'managed programmer without writer revocation',o:{role:'programmer',artifact:'registered',managed:true,workflow:'engineering-native-v1'},expect:'refused:retirement'},
  ];
  const planted=new Map<string,Planted>();
  for(const item of cases){
   const p=await plant(item.o);planted.set(item.label,p);
   const preview=await retire(p,false);
   assert.ok(await exists(p.work),item.label+': preview removes nothing');
   assert.ok(await exists(join(p.root,'review-artifact')),item.label+': preview keeps review-artifact');
   const result=await retire(p,true);
   const [state,detail]=item.expect.split(':');
   assert.equal(result.state,state,item.label+' '+JSON.stringify(result));
   const keepReview=result.state==='refused'||item.o.role==='programmer';
   if(result.state==='refused'){
    assert.equal(result.reason,detail,item.label);assert.ok(await exists(p.work),item.label+': work kept');
    assert.equal(preview.state,'refused',item.label);
    assert.equal(await audits(p.jobId,'native.exam_work_release_planned'),0,item.label+': no plan recorded');
   }else{
    assert.equal(result.category,detail,item.label);assert.equal(preview.state,'eligible',item.label);
    if(!keepReview&&detail==='passive-exam')assert.ok((preview.bytes??0)>=1600,item.label+': preview counts both work and review-artifact');
    assert.equal(await exists(p.work),false,item.label+': work gone');assert.equal(await audits(p.jobId),1,item.label);
   }
   await intact(p,keepReview);await outsideIntact();
  }

  // The artifact stays durable after the retirement: its private ref was created by CAS, survives garbage collection, is not moved by
  // the legitimate application of the artifact to a branch, and refuses any other value.
  const kept=planted.get('programmer, artifact registered: pinned by its private ref')!;
  assert.equal(retained(kept),kept.artifact!.commit);
  assert.equal(retained(planted.get('programmer, private ref already points elsewhere')!),commit,'a conflicting ref is never overwritten');
  assert.equal(retained(planted.get('programmer, artifact never registered')!),'','nothing is pinned for an unregistered artifact');
  git('update-ref','refs/heads/applied',kept.artifact!.commit,'0'.repeat(40));
  git('update-ref','refs/heads/applied',commit,kept.artifact!.commit);
  git('reflog','expire','--expire=now','--all');git('gc','-q','--prune=now');
  assert.equal(git('rev-parse',kept.artifact!.commit+'^{tree}'),kept.artifact!.tree,'the artifact survives garbage collection');
  assert.equal(retained(kept),kept.artifact!.commit,'applying the artifact never moves its private ref');
  assert.equal(await pinRetainedArtifact(repo,kept.jobId,commit,tree),'conflict');
  assert.equal(await pinRetainedArtifact(repo,kept.jobId,kept.artifact!.commit,kept.artifact!.tree),'kept');
  assert.equal(retained(kept),kept.artifact!.commit);
  assert.equal(retained(planted.get('managed programmer with its signed writer revocation')!),planted.get('managed programmer with its signed writer revocation')!.artifact!.commit);

  // Losing the session that holds the job lock, during preparation or right before removal, stops the retirement: nothing is removed
  // unprotected. A later healthy run finishes from the recorded plan.
  const terminateHolder=async(jobId:string)=>{
   const pid=(await db.pool.query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND ((classid::bigint<<32)|objid::bigint)=hashtextextended($1,0)`,['agent-control:terminal-work:'+jobId])).rows[0]?.pid;
   assert.ok(pid,'the job lock is held while observed');
   await db.pool.query('SELECT pg_terminate_backend($1)',[pid]);
   for(let i=0;i<100&&(await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[pid])).rowCount;i++)await new Promise(done=>setTimeout(done,20));
   await new Promise(done=>setTimeout(done,200));
  };
  for(const step of ['locked','prepared','removing'] as const){
   for(const o of [{role:'reviewer' as const,checkout:'good' as const},{role:'programmer' as const,artifact:'registered' as const}]){
    const p=await plant(o);
    const result=await supervisor.retireTerminalWork(owner,p.jobId,true,{...scope(p),observe:async seen=>{if(seen===step)await terminateHolder(p.jobId);}});
    assert.deepEqual(result,{jobId:p.jobId,state:'refused',reason:'session_lost'},step+' '+o.role);
    assert.ok(await exists(join(p.work,'.git')),step+': work untouched');
    assert.ok(await exists(join(p.root,'review-artifact')),step+': review-artifact untouched');
    assert.equal(await audits(p.jobId),0);
    assert.equal(await audits(p.jobId,'native.exam_work_release_planned'),step==='locked'?0:1,step);
    const again=await retire(p,true);
    assert.equal(again.state,'released',step+' retried '+JSON.stringify(again));
    assert.equal(await exists(p.work),false);assert.equal(await audits(p.jobId),1);await intact(p,o.role==='programmer');
   }
  }

  // 2. Job-level refusals shared by every category.
  const refused=async(label:string,reason:string,mutate:(p:Planted)=>Promise<void>,o:Plant={})=>{
   const p=await plant(o);await mutate(p);
   const result=await retire(p,true);
   assert.deepEqual([result.state,(result as {reason?:string}).reason],['refused',reason],label);
   assert.ok(await exists(p.work),label+': work kept');await intact(p,true);
  };
  await refused('grant not released','grant_state',async()=>undefined,{grantState:'reserved'});
  await refused('work is a symlink','work_unsafe',async p=>{await rm(p.work,{recursive:true});await symlink(outside,p.work);});
  await refused('review-artifact is a symlink','work_unsafe',async p=>{await rm(join(p.root,'review-artifact'),{recursive:true});await symlink(outside,join(p.root,'review-artifact'));});
  await refused('result no longer matches the receipt','receipt',p=>writeFile(join(p.root,'output','execution-result.json'),JSON.stringify({schemaVersion:1,jobId:p.jobId,output:'other',exitCode:0,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null})));
  const missingResult=await plant();
  await rm(join(missingResult.root,'output','execution-result.json'));
  assert.deepEqual(await retire(missingResult,true),{jobId:missingResult.jobId,state:'refused',reason:'output_missing'});
  assert.ok(await exists(missingResult.work));
  assert.equal(await audits(missingResult.jobId),0);
  assert.deepEqual(await retire(missingResult,true),{jobId:missingResult.jobId,state:'refused',reason:'output_missing'});
  await refused('job root is not private','directory_unsafe',p=>chmod(p.root,0o755));
  await outsideIntact();
  const stranger=await plant();
  assert.deepEqual(await supervisor.retireTerminalWork(owner,stranger.jobId,true,{...scope(stranger),projectId:randomUUID()}),{jobId:stranger.jobId,state:'refused',reason:'not_found'});
  assert.equal((await supervisor.retireTerminalWork('someone-else',stranger.jobId,true,scope(stranger)) as {reason?:string}).reason,'not_passive_exam');
  assert.ok(await exists(stranger.work));

  // 3. The service keeps running: its context lease is held, yet retention works and never touches the lease.
  const withGateway=await plant(),otherGateway=await plant({role:'reviewer',checkout:'good'});
  const gateway=await db.acquire(owner,withGateway.contextId,randomUUID(),'gateway',60);
  const leaseBefore=JSON.stringify((await db.pool.query('SELECT context_id,instance_id,epoch,lease_until FROM ac_managers WHERE context_id=$1',[withGateway.contextId])).rows);
  assert.equal((await retire(withGateway,true)).state,'released');
  assert.equal(JSON.stringify((await db.pool.query('SELECT context_id,instance_id,epoch,lease_until FROM ac_managers WHERE context_id=$1',[withGateway.contextId])).rows),leaseBefore,'the lease row is untouched');
  await db.heartbeat(gateway);
  assert.ok(await exists(otherGateway.work));
  // ... and the manual, lease-based path still reports a busy context for that same job.
  await db.releaseLease(gateway);

  // 4. Per-job mutual exclusion: another session holding the job's advisory lock makes the job busy, not failed.
  const held=await plant();
  const other=await db.pool.connect();
  try{
   await other.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['agent-control:terminal-work:'+held.jobId]);
   assert.deepEqual(await retire(held,true),{jobId:held.jobId,state:'refused',reason:'busy'});
   assert.ok(await exists(held.work));
   // The manual path honours the same lock.
   const lease=await db.acquire(owner,held.contextId,randomUUID(),'maintenance',60);
   try{assert.deepEqual(await supervisor.releaseModuleExamWork(owner,lease,held.jobId,true),{jobId:held.jobId,state:'refused',reason:'busy'});}finally{await db.releaseLease(lease);}
  }finally{await other.query('SELECT pg_advisory_unlock_all()');other.release();}
  assert.equal((await retire(held,true)).state,'released');

  // 5. The installation run: inventory, budget that refusals never spend, cursor, repeatability, concurrent runs, hook.
  const config={databaseUrl:fixture.url,dataDirectory:data,project:{id:project,repo,owner},projects:[],
   nativeBootstrap:{state:'active',accounts:[{accountId:account,subjectDigest:subject}],execution:{id:'personal-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,providerNetworkId:providerNetwork,signingKeyFile:keyFile,keyFingerprint:fingerprint,workerEnv:[],toolsEnv:[]}}} as never;
  const workIds=async()=>(await inventoryJobWork(spool)).ids;
  // Free whatever the earlier cases left eligible, so the counts below are about this section only.
  await runPersonalJobRetention(config,true);
  const stuck=[];for(let i=0;i<6;i++)stuck.push(await plant({role:'reviewer',retirement:'none'}));
  const good=[];for(let i=0;i<4;i++)good.push(await plant(i%2?{role:'reviewer',checkout:'good'}:{}));
  const start=await workIds();
  const before=await journal();
  const preview=(await runPersonalJobRetention(config,false)).join('\n');
  assert.match(preview,/Prévia de retenção, nada foi apagado: 4 elegível\(is\)/);assert.ok(Number(/retirement=(\d+)/.exec(preview)?.[1])>=6);
  assert.ok(preview.includes(`${missingResult.jobId}: work preservado (output_missing)`));
  assert.deepEqual(await workIds(),start);
  assert.equal(await exists(join(data,'job-work-retention.cursor')),false,'a preview leaves no cursor');
  // Budget of one: the six refused jobs never spend it, so every run still frees exactly one eligible job.
  for(let round=1;round<=4;round++){
   const text=(await runPersonalJobRetention(config,true,{limit:1})).join('\n');
   assert.match(text,/1 apagado\(s\)/,text);
   assert.equal((await workIds()).length,start.length-round);
  }
  const left=(await workIds());
  for(const p of stuck)assert.ok(left.includes(p.jobId));
  for(const p of good){assert.equal(await exists(p.work),false);await intact(p);assert.equal(await audits(p.jobId),1);}
  await outsideIntact();
  assert.equal(await journal(),before,'receipts and the retirement journal are untouched');
  const again=(await runPersonalJobRetention(config,true)).join('\n');
  assert.match(again,/0 apagado\(s\)/);assert.ok(Number(/retirement=(\d+)/.exec(again)?.[1])>=6);
  for(const p of good)assert.equal(await audits(p.jobId),1,'a repeat adds no audit');
  assert.equal(await exists(join(data,'job-work-retention.cursor')).then(async yes=>yes?await readRetentionCursor(join(data,'job-work-retention.cursor')):undefined),undefined,'a full pass resets the cursor');

  // Concurrent runs and a service that reconciles at the same time: each job is released exactly once, nothing fails.
  const racers=[];for(let i=0;i<6;i++)racers.push(await plant(i%2?{role:'reviewer',checkout:'good'}:{}));
  const outputs=await Promise.all([runPersonalJobRetention(config,true),runPersonalJobRetention(config,true),runPersonalJobRetention(config,true)]);
  const joined=outputs.map(lines=>lines.join('\n'));
  assert.ok(joined.some(text=>/6 apagado\(s\)/.test(text)||/já em execução/.test(text)),joined.join('\n---\n'));
  for(const text of joined)assert.doesNotMatch(text,/falhou|com falha, [1-9]/);
  for(const p of racers){assert.equal(await exists(p.work),false);assert.equal(await audits(p.jobId),1);await intact(p);}
  // The global lock is single-flight: a second run while one holds it does nothing.
  const guard=await db.pool.connect();
  try{
   await guard.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['agent-control:job-work-retention']);
   assert.match((await runPersonalJobRetention(config,true)).join('\n'),/já em execução/);
  }finally{await guard.query('SELECT pg_advisory_unlock_all()');guard.release();}

  // A plan whose removal finished but whose journal row was lost is closed on the next run, once.
  const crashed=await plant();
  const identify=async(path:string)=>{const st=await lstat(path,{bigint:true});return st.dev+':'+st.ino;};
  await db.pool.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'native.exam_work_release_planned',$2)",[crashed.contextId,{jobId:crashed.jobId,terminalDigest:digest(crashed.receipt),snapshot:{job:await identify(crashed.root),work:await identify(crashed.work),bytes:10}}]);
  await rm(crashed.work,{recursive:true});
  await runPersonalJobRetention(config,true);
  assert.equal(await audits(crashed.jobId,'native.exam_work_absent_after_plan'),1);
  await runPersonalJobRetention(config,true);
  assert.equal(await audits(crashed.jobId,'native.exam_work_absent_after_plan'),1);
  assert.equal(await exists(join(crashed.root,'review-artifact')),false,'remaining review-artifact of a job whose work was already gone is also retired');
  await intact(crashed,false);
  // A passive exam job whose work was already retired in a previous run (with both planned and released in ac_audit) still has its remaining review-artifact retired and repeated idempotently.
  const legacyRetired=await plant();
  const legacySnap={job:await identify(legacyRetired.root),work:await identify(legacyRetired.work),bytes:1000};
  for(const kind of ['native.exam_work_release_planned','native.exam_work_released'])
   await db.pool.query('INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,$2,$3)',[legacyRetired.contextId,kind,{jobId:legacyRetired.jobId,terminalDigest:digest(legacyRetired.receipt),snapshot:legacySnap}]);
  await rm(legacyRetired.work,{recursive:true});
  const legacyPreview=await retire(legacyRetired,false);
  assert.equal(legacyPreview.state,'eligible');
  assert.ok(legacyPreview.state==='eligible'&&(legacyPreview.bytes??0)>=600);
  const legacyApplied=await retire(legacyRetired,true);
  assert.equal(legacyApplied.state,'released');
  await intact(legacyRetired,false);
  assert.deepEqual(await retire(legacyRetired,true),{jobId:legacyRetired.jobId,state:'absent'});
  assert.deepEqual(await retire(legacyRetired,false),{jobId:legacyRetired.jobId,state:'absent'});

  // Budget and deadline stop early and leave a cursor behind; the next run resumes after it.
  const cursorRuns=[];for(let i=0;i<3;i++)cursorRuns.push(await plant());
  const first=(await runPersonalJobRetention(config,true,{limit:1})).join('\n');
  assert.match(first,/Parou no limite/);
  const cursor=await readRetentionCursor(join(data,'job-work-retention.cursor'));
  assert.ok(cursor&&cursorRuns.length===3,'an early stop leaves a cursor');
  const done=(await runPersonalJobRetention(config,true)).join('\n');
  assert.match(done,/2 apagado\(s\)/,done);
  assert.equal(await readRetentionCursor(join(data,'job-work-retention.cursor')),undefined);
  const timed=await plant();
  assert.match((await runPersonalJobRetention(config,true,{deadlineMs:1})).join('\n').replace(/\n/g,' '),/0 apagado\(s\)|1 apagado\(s\)/);
  await runPersonalJobRetention(config,true);
  assert.equal(await exists(timed.work),false);

  // Extension point for artifact retention: it runs after the job copies; a failing extension is reported and does not stop the others.
  const seen:string[]=[];
  const hook=(await runPersonalJobRetention(config,false,{extensions:[
   {name:'quebrada',run:async()=>{throw new Error('x');}},
   {name:'artefatos',run:async({apply,ledger})=>{seen.push(String(apply),String(ledger===undefined));return ['Artefatos: nada a retirar.'];}},
  ]})).join('\n');
  assert.match(hook,/Extensão de retenção quebrada falhou/);assert.match(hook,/Artefatos: nada a retirar\./);assert.deepEqual(seen,['false','false']);

  // Without an active runtime the run reports and changes nothing.
  assert.deepEqual(await runPersonalJobRetention({...(config as object),nativeBootstrap:undefined} as never,true),['Sem runtime nativo ativo: nenhuma cópia de job a retirar.']);
  assert.ok((await readdir(outside)).includes('precious.txt'));

  await t.test('retira review-artifact do revisor quando a retirada de work já foi auditada',async()=>{
   const reviewer=await plant({role:'reviewer',checkout:'good'});
   const reviewArtifact=join(reviewer.root,'review-artifact');
   const savedArtifact=join(area,reviewer.jobId);
   // Reproduz uma retirada anterior que alcançou apenas work.
   await rename(reviewArtifact,savedArtifact);
   const workResult=await retire(reviewer,true);
   assert.equal(workResult.state,'released');
   assert.equal(workResult.state==='released'&&workResult.category,'readonly-evaluator');
   assert.equal(await exists(reviewer.work),false);
   assert.equal(await audits(reviewer.jobId),1);
   await rename(savedArtifact,reviewArtifact);
   const preview=await retire(reviewer,false);
   assert.equal(preview.state,'eligible');
   await intact(reviewer,true);
   const result=await retire(reviewer,true);
   assert.equal(result.state,'released');
   assert.equal(result.state==='released'&&result.category,'readonly-evaluator');
   await intact(reviewer);
   assert.equal(await audits(reviewer.jobId),2);
   assert.deepEqual(await retire(reviewer,true),{jobId:reviewer.jobId,state:'absent'});
  });

  await t.test('preserva review-artifact do revisor quando work sumiu sem auditoria',async()=>{
   const reviewer=await plant({role:'reviewer',checkout:'good'});
   await rm(reviewer.work,{recursive:true});
   const refusal={jobId:reviewer.jobId,state:'refused',reason:'unregistered_change'};
   assert.deepEqual(await retire(reviewer,false),refusal);
   assert.deepEqual(await retire(reviewer,true),refusal);
   await intact(reviewer,true);
   assert.equal(await audits(reviewer.jobId,'native.exam_work_release_planned'),0);
   assert.equal(await audits(reviewer.jobId),0);
  });
 }finally{
  await db.pool.end().catch(()=>{});
  await fixture.close().catch(()=>{});
  await rm(area,{recursive:true,force:true});
 }
});
