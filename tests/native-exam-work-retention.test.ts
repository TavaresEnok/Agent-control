import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {releaseExamWorkFromInstallation,runPersonalMaintenance} from '../src/personal-maintenance.ts';
import {Refusal,canonical,digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exists=(path:string)=>lstat(path).then(()=>true,()=>false);

test('work retention accepts only the stated usage',async()=>{
 const usage=async(...args:string[])=>runPersonalMaintenance(['/nonexistent/installation.json',...args]).then(()=>'ok',error=>error instanceof Refusal?error.code:String(error));
 const id=randomUUID();
 for(const args of [
  ['--liberar-work-exames'],
  ['--liberar-work-exames','--aplicar'],
  ['--liberar-work-exames','--projeto','not-a-uuid'],
  ['--liberar-work-exames','--projeto',id,'--job',id],
  ['--liberar-work-exames','--projeto',id,'--projeto',id],
  ['--liberar-work-exames','--projeto',id,'--limite','0'],
  ['--liberar-work-exames','--projeto',id,'--limite','201'],
  ['--liberar-work-exames','--job',id,'--limite','5'],
  ['--liberar-work-exames','--job','../../etc'],
  ['--liberar-work-exames','--projeto',id,'--tudo'],
  ['--liberar-work-exames','--projeto'],
 ])assert.equal(await usage(...args),'MAINTENANCE_USAGE',args.join(' '));
 // Valid usage passes the parser and only then fails on the missing installation file.
 assert.notEqual(await usage('--liberar-work-exames','--projeto',id,'--limite','200','--aplicar'),'MAINTENANCE_USAGE');
 assert.notEqual(await usage('--liberar-work-exames','--job',id,'--job',randomUUID()),'MAINTENANCE_USAGE');
});

test('finished passive exam work copies are released only with the full proof, only the literal work child, and repeatably',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'workret');
 const db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-workret-'));
 try{
  await db.migrate();
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const capacity=new Capacity(db);
  const project=randomUUID(),owner='app-'+randomUUID(),operator='operator-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'exec-host'),accounts=join(area,'accounts'),outside=join(area,'outside');
  for(const dir of [repo,spool,accounts,outside]){await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);}
  await writeFile(join(outside,'precious.txt'),'must survive');
  const commit='e'.repeat(40),image='sha256:'+'0'.repeat(64),providerNetwork='d'.repeat(64);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Work retention fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'operator')",[project,owner,operator]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const subject=digest({provider:'claude',subject:'work-retention-fixture'});
  await capacity.addAccount(owner,project,{id:account,provider:'claude',label:'work retention fixture',resourceIdentity:'claude:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:2});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'claude-sonnet-5-5','medium','specialist',true)",[profile,account]);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),owner]);
  const keys=generateKeyPairSync('ed25519'),otherKeys=generateKeyPairSync('ed25519');
  const pemOf=(pair:typeof keys)=>pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  const keyFile=join(area,'execution.key');await writeFile(keyFile,pemOf(keys),{mode:0o600});
  const supervisorFor=(pem:string)=>new NativeExecutionSupervisor(db,{id:'personal-execution-claude',provider:'claude',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:pem,providerNetworkId:providerNetwork,workerEnv:[],toolsEnv:[],accountSubjects:[{accountId:account,subjectDigest:subject}]},{assertAdmission:async()=>{}});
  const supervisor=supervisorFor(pemOf(keys));
  const profileDigest=digest({accountId:account,profileId:profile,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  const hex=(label:string)=>createHash('sha256').update(label).digest('hex');
  const signWith=(key:typeof keys.privateKey,domain:string,payload:unknown)=>sign(null,Buffer.from(domain+canonical(payload)),key).toString('hex');
  const receiptDomain='agent-control:native-execution-receipt:v1\n',retirementDomain='agent-control:native-terminal-retirement:v1\n';

  type Plant={workflow?:string;state?:string;grantState?:string;retirement?:'removed'|'prepared'|'none'|'forged'|'mismatch';receiptKey?:typeof keys.privateKey;work?:'tree'|'none'|'symlink'|'file';rootMode?:number};
  const plant=async(o:Plant={})=>{
   const contextId=await db.createContext(owner,project,randomUUID());
   const intentId=randomUUID(),jobId=randomUUID(),grantId=randomUUID(),sessionId=randomUUID();
   const command={schemaVersion:1 as const,intentId,deliveryAttemptId:randomUUID(),contextId,policyRevision:0,action:'plan.start' as const,payload:{workflow:o.workflow??'security-verify-readonly-v1',messageRef:`qa:${project}:${commit}`,projectId:project,commit}};
   await db.pool.query(`INSERT INTO ac_intents (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,1,0)`,
    [intentId,contextId,owner,digest(command),JSON.stringify(command),randomUUID(),randomUUID()]);
   const workerId=hex('w'+jobId),toolsId=hex('t'+jobId),networkId=hex('n'+jobId),inputDigest=digest({jobId});
   const physical={jobId,containerId:workerId,toolsContainerId:toolsId,networkId,exitCode:0,workerExitCode:0,finishedAt:'2026-11-20T01:00:00Z',toolsFinishedAt:'2026-11-20T01:00:01Z'};
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
    VALUES($1,$2,$3,$4,1,$5,$6,'specialist',$7,1,1,$8,false,$9,$10)`,[grantId,randomUUID(),intentId,contextId,account,profile,project,digest({grantId}),o.grantState??'released',physical]);
   const payload={schemaVersion:1,accountId:account,profileId:profile,profileDigest,jobId,intentId,contextId,grantId,sessionId,epoch:1,inputDigest,executorDigest:supervisor.executorDigest,outputDigest:digest(''),physicalDigest:digest(physical),workerExitCode:0,artifact:null,exitCode:0};
   const receipt={payload,signature:signWith(o.receiptKey??keys.privateKey,receiptDomain,payload)};
   await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,network_id,worker_id,tools_id,launch_digest,receipt)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,1,$9,$10,$11,$12,'specialist',$13,$14,$15,$16,$17,$18)`,
    [jobId,grantId,intentId,contextId,sessionId,account,profile,profileDigest,supervisor.executorDigest,fingerprint,inputDigest,commit,o.state??'completed',networkId,workerId,toolsId,hex('l'+jobId),receipt]);
   const binding={schemaVersion:1,jobId,contextId,intentId,grantId,sessionId,epoch:1,role:'specialist',inputDigest,terminalDigest:digest(receipt),workerId,toolsId,networkId,workerLogSha256:hex('wl'),toolsLogSha256:hex('tl')};
   const mode=o.retirement??'removed';
   if(mode!=='none'){
    const saved=mode==='mismatch'?{...binding,terminalDigest:digest('other')}:binding;
    await db.pool.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[jobId,saved]);
    if(mode!=='prepared')await db.pool.query("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1",[jobId,{payload:saved,signature:signWith(mode==='forged'?otherKeys.privateKey:keys.privateKey,retirementDomain,saved)}]);
   }
   const root=join(spool,jobId),work=join(root,'work');
   await mkdir(root,{mode:0o700});await chmod(root,o.rootMode??0o700);
   for(const dir of ['input','output','planning','review-artifact'])await mkdir(join(root,dir),{mode:0o700});
   await writeFile(join(root,'output','execution-result.json'),JSON.stringify({schemaVersion:1,jobId,output:'',exitCode:0,normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:null}),{mode:0o600});
   await writeFile(join(root,'review-artifact','a.txt'),'artifact');
   await writeFile(join(root,'worker-terminal.log'),'log');
   if(o.work==='symlink')await symlink(outside,work);
   else if(o.work==='file')await writeFile(work,'x');
   else if(o.work!=='none'){
    await mkdir(join(work,'src'),{recursive:true});await writeFile(join(work,'src','index.ts'),'x'.repeat(1000));
    await mkdir(join(work,'.git'));await writeFile(join(work,'.git','HEAD'),'ref');
    // Links inside a work copy are removed as links; their targets are never followed.
    await symlink(outside,join(work,'link-out'));await symlink(join(outside,'precious.txt'),join(work,'link-file'));
   }
   return {jobId,contextId,root,work};
  };
  type Planted={jobId:string;contextId:string;root:string;work:string};
  const run=async(p:{jobId:string;contextId:string},apply:boolean,principal=owner,by=supervisor)=>{
   const authority=await db.acquire(principal,p.contextId,randomUUID(),'personal-maintenance',60);
   try{return await by.releaseModuleExamWork(principal,authority,p.jobId,apply);}finally{await db.releaseLease(authority);}
  };
  const intact=async(p:Planted)=>{
   for(const name of ['input','output','planning','review-artifact'])assert.ok(await exists(join(p.root,name)),name+' kept');
   assert.equal(JSON.parse(await readFile(join(p.root,'output','execution-result.json'),'utf8')).jobId,p.jobId);
   assert.equal(await readFile(join(p.root,'review-artifact','a.txt'),'utf8'),'artifact');
   assert.equal(await readFile(join(p.root,'worker-terminal.log'),'utf8'),'log');
  };
  const outsideIntact=async()=>assert.equal(await readFile(join(outside,'precious.txt'),'utf8'),'must survive');
  const journal=async()=>JSON.stringify((await db.pool.query('SELECT job_id,state,binding,proof FROM ac_native_terminal_retirements ORDER BY job_id')).rows);
  const audits=async(jobId:string)=>(await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='native.exam_work_released' AND detail->>'jobId'=$1",[jobId])).rows[0].n as number;

  const noOutput=await plant();
  await rm(join(noOutput.root,'output','execution-result.json'));
  assert.deepEqual(await run(noOutput,true),{jobId:noOutput.jobId,state:'refused',reason:'receipt'});
  assert.ok(await exists(noOutput.work));
  const design=await plant({workflow:'design-readonly-v1'});
  await db.pool.query("UPDATE ac_capacity_grants SET selection=jsonb_set(coalesce(selection,'{}'::jsonb),'{designPurpose}',to_jsonb('examiner'::text)) WHERE id=(SELECT grant_id FROM ac_native_execution_jobs WHERE id=$1)",[design.jobId]);
  assert.equal((await run(design,true)).state,'released');
  await intact(design);
  const interrupted=await plant();
  await db.pool.query(`CREATE FUNCTION fail_retention_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='native.exam_work_released' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER retention_audit_failure BEFORE INSERT ON ac_audit FOR EACH ROW EXECUTE FUNCTION fail_retention_audit()`);
  try{await assert.rejects(run(interrupted,true),/synthetic audit failure/);}
  finally{await db.pool.query('DROP TRIGGER retention_audit_failure ON ac_audit; DROP FUNCTION fail_retention_audit()');}
  assert.equal(await exists(interrupted.work),false);
  assert.equal(await audits(interrupted.jobId),0);
  assert.equal((await run(interrupted,true)).state,'absent');
  assert.equal(await audits(interrupted.jobId),0);
  assert.equal((await db.pool.query("SELECT 1 FROM ac_audit WHERE kind='native.exam_work_absent_after_plan' AND detail->>'jobId'=$1",[interrupted.jobId])).rowCount,1);
  // 1. Inspection changes nothing; apply frees only work, leaves the journal and siblings alone, and is repeatable.
  const a=await plant(),neighbour=await plant();
  const before=await journal();
  const preview=await run(a,false);
  assert.equal(preview.state,'eligible');
  assert.ok(preview.state==='eligible'&&(preview.bytes??0)>=1000);
  assert.ok(await exists(a.work));
  assert.equal((await run(a,true)).state,'released');
  assert.equal(await exists(a.work),false);
  await intact(a);await outsideIntact();
  assert.ok(await exists(neighbour.work),'a sibling job keeps its work');await intact(neighbour);
  assert.equal(await journal(),before,'the retirement journal is untouched');
  assert.equal(await audits(a.jobId),1);
  assert.deepEqual(await run(a,true),{jobId:a.jobId,state:'absent'});
  assert.deepEqual(await run(a,false),{jobId:a.jobId,state:'absent'});
  assert.equal(await audits(a.jobId),1,'a repeat adds no audit');

  // 2. Negatives: wrong state, proof, type or scope. Nothing is removed and the reason is named.
  const refused=async(label:string,reason:string,o:Plant,principal=owner)=>{
   const p=await plant(o);
   const result=await run(p,true,principal);
   assert.deepEqual([result.state,(result as {reason?:string}).reason],['refused',reason],label);
   assert.ok(await exists(p.work),label+': work kept');await intact(p);await outsideIntact();
  };
  await refused('failed job','job_state',{state:'failed'});
  await refused('grant not released','grant_state',{grantState:'reserved'});
  await refused('design exam','not_passive_exam',{workflow:'design-readonly-v1'});
  await refused('no retirement','retirement',{retirement:'none'});
  await refused('retirement only prepared','retirement',{retirement:'prepared'});
  await refused('forged retirement proof','retirement',{retirement:'forged'});
  await refused('retirement bound to another receipt','retirement',{retirement:'mismatch'});
  await refused('receipt signed by another key','receipt',{receiptKey:otherKeys.privateKey});
  await refused('another principal','not_passive_exam',{},operator);
  await refused('work is a symlink','work_unsafe',{work:'symlink'});
  await refused('work is a file','work_unsafe',{work:'file'});
  await refused('job root is not private','directory_unsafe',{rootMode:0o755});
  assert.ok((await readdir(outside)).includes('precious.txt'));
  // A job asked for through another job's context is not found, never guessed.
  const asked=await plant(),elsewhere=await plant();
  assert.deepEqual(await run({jobId:asked.jobId,contextId:elsewhere.contextId},true),{jobId:asked.jobId,state:'refused',reason:'not_found'});
  assert.ok(await exists(asked.work));
  // A supervisor whose key is not the job's key cannot judge it.
  const foreign=await plant();
  assert.equal((await run(foreign,true,owner,supervisorFor(pemOf(otherKeys))) as {reason?:string}).reason,'supervisor_identity');
  assert.ok(await exists(foreign.work));

  // 3. Installation batch: project scope with limit, ids, busy context, repeat.
  const batchA=await plant(),batchB=await plant(),batchDone=await plant({work:'none'}),bystander=await plant({retirement:'prepared'});
  const config={databaseUrl:fixture.url,project:{id:project,repo,owner},projects:[],
   nativeBootstrap:{state:'active',accounts:[{accountId:account,subjectDigest:subject}],execution:{id:'personal-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,providerNetworkId:providerNetwork,signingKeyFile:keyFile,keyFingerprint:fingerprint,workerEnv:[],toolsEnv:[]}}} as never;
  const projectScope=async(apply:boolean,limit=50)=>(await releaseExamWorkFromInstallation(config,{apply,projectId:project,limit})).join('\n');
  const workCount=async()=>(await Promise.all((await readdir(spool)).map(name=>exists(join(spool,name,'work'))))).filter(Boolean).length;
  const start=await workCount();
  await assert.rejects(releaseExamWorkFromInstallation(config,{apply:true,jobIds:[batchA.jobId],projectId:project,limit:1}), (e:unknown)=>e instanceof Refusal&&e.code==='MAINTENANCE_USAGE');
  await assert.rejects(releaseExamWorkFromInstallation(config,{apply:true,jobIds:Array(201).fill(batchA.jobId),limit:1}), (e:unknown)=>e instanceof Refusal&&e.code==='MAINTENANCE_USAGE');
  const state=await journal();
  const previewText=await projectScope(false);
  assert.match(previewText,/Prévia, nada foi apagado/);
  assert.ok(previewText.includes(batchA.jobId)&&previewText.includes(batchB.jobId));
  assert.ok(!previewText.includes(batchDone.jobId)&&!previewText.includes(bystander.jobId),'a job already without work or without a removed retirement is not offered');
  assert.equal(await workCount(),start);
  assert.match(await projectScope(true,1),/1 apagado\(s\)/);
  assert.equal(await workCount(),start-1);
  assert.match(await projectScope(true,1),/1 apagado\(s\)/);
  assert.equal(await workCount(),start-2);
  const rest=await projectScope(true);
  assert.match(rest,/recusado \(grant_state\)/);assert.match(rest,/recusado \(retirement\)/);assert.match(rest,/recusado \(receipt\)/);
  assert.ok(await exists(bystander.work),'a job without a removed retirement keeps its work');
  const stable=await workCount();
  assert.match(await projectScope(true),/0 apagado\(s\)/);
  assert.equal(await workCount(),stable,'a repeated batch removes nothing more');
  assert.equal(await journal(),state);
  for(const p of [batchA,batchB,batchDone])await intact(p);
  await outsideIntact();

  const target=await plant(),busy=await plant(),missing=randomUUID();
  const gateway=await db.acquire(owner,busy.contextId,randomUUID(),'gateway',60);
  const byIds=(await releaseExamWorkFromInstallation(config,{apply:true,jobIds:[target.jobId,busy.jobId,missing,bystander.jobId],limit:50})).join('\n');
  assert.ok(byIds.includes(`${target.jobId}: work apagado`),byIds);
  assert.ok(byIds.includes(`${busy.jobId}: contexto ocupado`),byIds);
  assert.ok(byIds.includes(`${missing}: recusado (not_found)`),byIds);
  assert.ok(byIds.includes(`${bystander.jobId}: recusado (retirement)`),byIds);
  assert.equal(await exists(target.work),false);assert.ok(await exists(busy.work));assert.ok(await exists(bystander.work));
  await db.releaseLease(gateway);
  const retried=(await releaseExamWorkFromInstallation(config,{apply:true,jobIds:[busy.jobId,target.jobId],limit:50})).join('\n');
  assert.ok(retried.includes(`${busy.jobId}: work apagado`),retried);
  assert.ok(retried.includes('1 apagado(s)')&&retried.includes('1 já sem work'),retried);
  // A project that is not configured is refused outright, before any scan.
  await assert.rejects(releaseExamWorkFromInstallation(config,{apply:true,projectId:randomUUID(),limit:50}),(error:unknown)=>error instanceof Refusal&&error.code==='MAINTENANCE_EXAM_NOT_FOUND');
  await outsideIntact();
 }finally{
  await db.pool.end().catch(()=>{});
  await fixture.close().catch(()=>{});
  await rm(area,{recursive:true,force:true});
 }
});
