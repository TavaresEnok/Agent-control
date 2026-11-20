import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {digest,Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {Quality,authorizeExplicitQaWaiver,waiveQaInTransaction} from '../src/quality.ts';
import {QualityPolicies} from '../src/quality-policy.ts';
import {ProjectTemplates} from '../src/project-templates.ts';
import {GitArtifacts} from '../src/git.ts';
import {Integrator} from '../src/integration.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
const historical={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:true,requireJudge:false,requireHumanIntegration:false,verifierDigest:'ab'.repeat(32)};

test('an integration that fails before its write is retryable; a lost answer after the write is reconciled; nobody overwrites a third party',{skip:!process.env.AC_TEST_DATABASE_URL,timeout:120000},async()=>{
 const fixture=await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!,'integrec'),db=new Ledger(fixture.url);await db.migrate();
 const area=await mkdtemp(join(tmpdir(),'ac-integration-recovery-'));
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
  await rm(repo,{recursive:true,force:true});await mkdir(repo);gitcmd('init','-q','-b','lab');gitcmd('config','user.email','fixture@example.invalid');gitcmd('config','user.name','Fixture');
  await writeFile(join(repo,'doc.txt'),'base\n');gitcmd('add','.');gitcmd('commit','-qm','base');const base=gitcmd('rev-parse','HEAD');
  await writeFile(join(repo,'doc.txt'),'change\n');gitcmd('commit','-qam','change');const commit=gitcmd('rev-parse','HEAD'),tree=gitcmd('rev-parse','HEAD^{tree}');gitcmd('update-ref','refs/heads/lab',base,commit);
  const env=await project('integrec-'+randomUUID()),git=new GitArtifacts(repo),quality=new Quality(db,randomBytes(32),git);
  const artifactId=await artifact(env,commit,tree,base,[{kind:'review',status:'passed'}]);
  await db.tx(c=>authorizeExplicitQaWaiver(c,env.owner,env.context,env.binding));
  await db.tx(c=>waiveQaInTransaction(c,env.owner,env.context,artifactId,'fixture',env.binding));
  const integration=await quality.prepareIntegration(env.owner,artifactId,env.authority,'refs/heads/lab');
  const integrator=new Integrator(db,quality,git,env.id,'refs/heads/lab');
  return {env,git,integrator,integration,base,commit};
 };
 const row=async(id:string)=>(await db.pool.query('SELECT state,receipt FROM ac_integration_intents WHERE id=$1',[id])).rows[0];
 const audits=async(kind:string,id:string)=>Number((await db.pool.query("SELECT count(*) n FROM ac_audit WHERE kind=$1 AND detail->>'integrationId'=$2",[kind,id])).rows[0].n);
 const thirdParty=(from:string)=>{gitcmd('checkout','-q','--detach',from);execFileSync('git',['-C',repo,'-c','user.email=third@example.invalid','-c','user.name=Third','commit','-q','--allow-empty','-m','third party work']);const sha=gitcmd('rev-parse','HEAD');gitcmd('update-ref','refs/heads/lab',sha);return sha;};
 try{
  const lost=(f:Awaited<ReturnType<typeof prepare>>,when:'before'|'after')=>{
   const real=f.git.cas.bind(f.git);
   (f.git as any).cas=async(...args:Parameters<typeof real>)=>{if(when==='after')await real(...args);throw new Refusal('GIT_HELPER_TIMEOUT');};
  };

  // 1. Failure BEFORE the write (the Git identity check cannot run): nothing was requested, so a normal attempt is possible again.
  {
   const f=await prepare(),identity=f.git.identity.bind(f.git);
   (f.git as any).identity=async()=>{throw new Refusal('GIT_HELPER_TIMEOUT');};
   await assert.rejects(f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority),(e:unknown)=>e instanceof Refusal&&e.code==='GIT_HELPER_TIMEOUT');
   assert.equal((await row(f.integration.id)).state,'registered','a refusal before the write must not leave the intention uncertain');
   assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.base);assert.equal(await audits('integration.returned_unwritten',f.integration.id),1);
   (f.git as any).identity=identity;
   assert.equal((await f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority)).status,'integrated');
   assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.commit);
  }

  // 2. Failure before the write, then a legitimate third party advances the branch: the retry is rejected by the CAS, never overwrites.
  {
   const f=await prepare(),identity=f.git.identity.bind(f.git);
   (f.git as any).identity=async()=>{throw new Refusal('GIT_HELPER_TIMEOUT');};
   await assert.rejects(f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority));
   const external=thirdParty(f.base);
   (f.git as any).identity=identity;
   const result=await f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority);
   assert.deepEqual(result,{status:'rejected',reason:'BASE_MOVED'});
   assert.equal((await row(f.integration.id)).state,'rejected');assert.equal(gitcmd('rev-parse','refs/heads/lab'),external,'the third party work stays');
  }

  // 3. The write happened but the answer was lost: stays uncertain, reconcile concludes from the exact observed postcondition.
  {
   const f=await prepare();lost(f,'after');
   await assert.rejects(f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority),(e:unknown)=>e instanceof Refusal&&e.code==='GIT_HELPER_TIMEOUT');
   assert.equal((await row(f.integration.id)).state,'uncertain');assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.commit);
   await assert.rejects(f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority),(e:unknown)=>e instanceof Refusal&&e.code==='INTEGRATION_UNCERTAIN');
   const receipt=await f.integrator.reconcile(f.env.owner,f.integration.id,f.env.authority);
   assert.equal(receipt?.status,'integrated');assert.equal(receipt?.reconciliation.observedHead,f.commit);
   assert.equal((await row(f.integration.id)).state,'integrated');assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.commit);
  }

  // 4. The answer was lost and the write did NOT happen. A fresh intention waits (an orphaned helper could still land); after that
  //    the unchanged base proves no write, so the intention returns to registered and a normal attempt works.
  {
   const f=await prepare();lost(f,'before');
   await assert.rejects(f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority),(e:unknown)=>e instanceof Refusal&&e.code==='GIT_HELPER_TIMEOUT');
   assert.equal((await row(f.integration.id)).state,'uncertain');
   assert.equal(await f.integrator.reconcile(f.env.owner,f.integration.id,f.env.authority),null);
   assert.equal((await row(f.integration.id)).state,'uncertain','a write requested seconds ago may still land');
   await db.pool.query("UPDATE ac_audit SET created_at=clock_timestamp()-interval '5 minutes' WHERE kind='integration.write_intended' AND detail->>'integrationId'=$1",[f.integration.id]);
   assert.equal(await f.integrator.reconcile(f.env.owner,f.integration.id,f.env.authority),null);
   assert.equal((await row(f.integration.id)).state,'registered');assert.equal(await audits('integration.reconciled_unwritten',f.integration.id),1);
   assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.base);
   (f.git as any).cas=GitArtifacts.prototype.cas.bind(f.git);
   assert.equal((await f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority)).status,'integrated');
   assert.equal(gitcmd('rev-parse','refs/heads/lab'),f.commit);
  }

  // 5. The write happened, then a third party moved the branch on: reconcile writes nothing, keeps the intention uncertain and records the divergence once.
  {
   const f=await prepare();lost(f,'after');
   await assert.rejects(f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority));
   const external=thirdParty(f.commit);
   assert.equal(await f.integrator.reconcile(f.env.owner,f.integration.id,f.env.authority),null);
   assert.equal(await f.integrator.reconcile(f.env.owner,f.integration.id,f.env.authority),null);
   assert.equal((await row(f.integration.id)).state,'uncertain');assert.equal(gitcmd('rev-parse','refs/heads/lab'),external);
   assert.equal(await audits('integration.reconcile_diverged',f.integration.id),1);
   await assert.rejects(f.integrator.integrate(f.env.owner,f.integration.id,f.env.authority),(e:unknown)=>e instanceof Refusal&&e.code==='INTEGRATION_UNCERTAIN');
   assert.equal(gitcmd('rev-parse','refs/heads/lab'),external);
  }
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
