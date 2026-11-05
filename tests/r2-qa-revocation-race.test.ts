import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {digest,Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {Quality,authorizeExplicitQaWaiver,waiveQaInTransaction,revokeExplicitQaWaiver} from '../src/quality.ts';
import {QualityPolicies} from '../src/quality-policy.ts';
import {ProjectTemplates} from '../src/project-templates.ts';
import {GitArtifacts} from '../src/git.ts';
import {Integrator} from '../src/integration.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
const historical={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:true,requireJudge:false,requireHumanIntegration:false,verifierDigest:'ab'.repeat(32)};
test('revocation held before gate serializes commit and rollback; killed controller leaves CAS uncertain', {skip:!process.env.AC_TEST_DATABASE_URL,timeout:90000},async()=>{
 const fixture=await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!,'qarace'),db=new Ledger(fixture.url);await db.migrate();
 const area=await mkdtemp(join(tmpdir(),'ac-r2-qa-race-'));
  async function project(owner: string) {
    const id = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [id, owner]);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [id, owner]);
    const revision = await new QualityPolicies(db).publish(owner, id, 0, historical);
    await db.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,$3,$4)', [id, digest({ schemaVersion: 1 }), { schemaVersion: 1 }, owner]);
    const account = randomUUID();
    const profile = randomUUID();
    await db.pool.query(`INSERT INTO ac_accounts(id,owner_id,provider,label,resource_identity,mode,eligibility,eligibility_source,max_concurrent)
      VALUES($1,$2,'fixture','fixture',$3,'synthetic','documented_supported','synthetic://fixture',4)`, [account, owner, account]);
    await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,'fixture-model','medium','programmer')", [profile, account]);
    const context = await db.createContext(owner, id, randomUUID());
    const authority = await db.acquire(owner, context, randomUUID(), 'fixture-manager', 60);
    const templateId = randomUUID();
    const template = { workflow: 'engineering-synthetic-v1' as const, qualityRevision: revision, targetRef: 'refs/heads/lab' };
    const published = await new ProjectTemplates(db).publish(owner, context, { templateId, expectedRevision: 0, name: 'Baixo risco', template, digest: digest(template) });
    const binding = { policyRevision: revision, templateId, templateRevision: published.revision, taskId: 'docs', riskRule: 'explicit-low' as const };
    return { id, owner, revision, account, profile, context, authority, binding };
  }

  async function artifact(env: Awaited<ReturnType<typeof project>>, commit: string, tree: string, base: string, evidence: readonly { kind: 'qa' | 'review'; status: string }[] = []) {
    const intentId = randomUUID();
    const operationId = randomUUID();
    const command = { schemaVersion: 1, intentId };
    await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)`, [intentId, env.context, env.owner, digest(command), command, operationId, randomUUID(), env.authority.epoch]);
    await db.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch) VALUES($1,$2,'completed',$3)", [operationId, intentId, env.authority.epoch]);
    const grant = async (role: 'programmer' | 'qa' | 'reviewer') => {
      const id = randomUUID();
      const profile = role === 'programmer' ? env.profile : randomUUID();
      if (role !== 'programmer') await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,'fixture-model','medium',$3)", [profile, env.account, role]);
      await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,$10,false,'released')`,
        [id, randomUUID(), intentId, env.context, env.authority.epoch, env.account, profile, role, env.id, digest(id)]);
      return id;
    };
    const artifactId = randomUUID();
    await db.pool.query('INSERT INTO ac_artifacts VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [artifactId, env.context, intentId, await grant('programmer'), randomUUID(), env.id, env.revision, commit, tree, base, digest({ commit, tree, base }), 'low']);
    for (const item of evidence) {
      const receipt = { kind: item.kind, status: item.status };
      await db.pool.query(`INSERT INTO ac_verification_evidence(id,artifact_id,kind,session_id,grant_id,policy_revision,status,receipt,receipt_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), artifactId, item.kind, randomUUID(), await grant(item.kind === 'qa' ? 'qa' : 'reviewer'), env.revision, item.status, receipt, digest(receipt)]);
    }
    return artifactId;
  }


 const repo=join(area,'repo');
 const gitcmd=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 const prepare=async()=>{
  await rm(repo,{recursive:true,force:true});await import('node:fs/promises').then(fs=>fs.mkdir(repo));gitcmd('init','-q','-b','lab');gitcmd('config','user.email','fixture@example.invalid');gitcmd('config','user.name','Fixture');
  await writeFile(join(repo,'doc.txt'),'base\n');gitcmd('add','.');gitcmd('commit','-qm','base');const base=gitcmd('rev-parse','HEAD');
  await writeFile(join(repo,'doc.txt'),'change\n');gitcmd('commit','-qam','change');const commit=gitcmd('rev-parse','HEAD'),tree=gitcmd('rev-parse','HEAD^{tree}');gitcmd('update-ref','refs/heads/lab',base,commit);
  const env=await project('race-'+randomUUID()),git=new GitArtifacts(repo),quality=new Quality(db,randomBytes(32),git);
  const artifactId=await artifact(env,commit,tree,base,[{kind:'review',status:'passed'}]);
  await db.tx(c=>authorizeExplicitQaWaiver(c,env.owner,env.context,env.binding));
  await db.tx(c=>waiveQaInTransaction(c,env.owner,env.context,artifactId,'fixture',env.binding));
  const auth=(await db.pool.query('SELECT authorization_id FROM ac_qa_waivers WHERE artifact_id=$1',[artifactId])).rows[0].authorization_id;
  const integration=await quality.prepareIntegration(env.owner,artifactId,env.authority,'refs/heads/lab');
  return {env,git,quality,artifactId,auth,integration,base,commit};
 };
 try{
  for(const disposition of ['commit','rollback'] as const){
   const f=await prepare(),holder=await db.pool.connect();let pending:Promise<any>|undefined;
   try{
    // Pause only between admission commit and the second transaction; the
    // revocation then holds its actual PostgreSQL row lock before the CAS gate.
    const originalTx=db.tx.bind(db);let entered!:()=>void,release!:()=>void;
    const admitted=new Promise<void>(r=>{entered=r;}),proceed=new Promise<void>(r=>{release=r;});let transactions=0;
    (db as any).tx=async(fn:any)=>{if(++transactions===2){entered();await proceed;}return originalTx(fn);};
    const integrator=new Integrator(db,f.quality,f.git,f.env.id,'refs/heads/lab');pending=integrator.integrate(f.env.owner,f.integration.id,f.env.authority);
    await admitted;(db as any).tx=originalTx;
    assert.equal((await db.pool.query('SELECT state FROM ac_integration_intents WHERE id=$1',[f.integration.id])).rows[0].state,'uncertain');
    await holder.query('BEGIN');await revokeExplicitQaWaiver(holder,f.env.owner,f.env.context,{authorizationId:f.auth});
    const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;release();
    let blocked=false;for(let i=0;i<100;i++){const q=await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid]);if(q.rowCount){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}
    assert.equal(blocked,true,'gate did not wait on revocation');assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.base);
    await holder.query(disposition==='commit'?'COMMIT':'ROLLBACK');
    if(disposition==='commit'){
     await assert.rejects(pending,(e:unknown)=>e instanceof Refusal&&e.code==='QA_MISSING');assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.base);
    }else{assert.equal((await pending).status,'integrated');assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.commit);}
   }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await pending?.catch(()=>{});}
  }
  const f=await prepare();
  const childCode=`import {Ledger} from './src/ledger.ts';import {Quality} from './src/quality.ts';import {GitArtifacts} from './src/git.ts';import {Integrator} from './src/integration.ts';const x=JSON.parse(process.env.R2_CHILD);const db=new Ledger(x.url);const git=new GitArtifacts(x.repo);git.identity=async()=>{process.stdout.write('BEFORE_CAS\\n');await new Promise(()=>{});};await new Integrator(db,new Quality(db,Buffer.alloc(32),git),git,x.project,'refs/heads/lab').integrate(x.owner,x.id,x.authority);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',childCode],{cwd:process.cwd(),env:{...process.env,R2_CHILD:JSON.stringify({url:fixture.url,repo,project:f.env.id,owner:f.env.owner,id:f.integration.id,authority:f.env.authority})},stdio:['ignore','pipe','pipe']});
  try{
   let out='';await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child marker timeout')),15000);child.stdout.on('data',b=>{out+=b;if(out.includes('BEFORE_CAS')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('child exited before marker'));});});
  }finally{
   if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;}
  }
  assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.base);
  assert.equal((await db.pool.query('SELECT state FROM ac_integration_intents WHERE id=$1',[f.integration.id])).rows[0].state,'uncertain');
  const integrator=new Integrator(db,f.quality,f.git,f.env.id,'refs/heads/lab');assert.equal(await integrator.reconcile(f.env.owner,f.integration.id,f.env.authority),null);
  await assert.rejects(integrator.integrate(f.env.owner,f.integration.id,f.env.authority),(e:unknown)=>e instanceof Refusal&&e.code==='INTEGRATION_UNCERTAIN');
  assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.base);
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
