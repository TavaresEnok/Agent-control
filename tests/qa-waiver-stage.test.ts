import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { digest, Refusal } from '../src/contracts.ts';
import type { Ledger } from '../src/ledger.ts';
import { isolatedDatabase } from './fixtures/isolated-database.ts';
import { Control } from '../src/control.ts';
import { Operators, operatorMessage } from '../src/operator.ts';

const skip = process.env.AC_TEST_DATABASE_URL ? false : 'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado';
const verifier = 'ab'.repeat(32);
const historical = { schemaVersion: 1 as const, requiredReviews: 1, allowLowRiskQaWaiver: true, requireJudge: false, requireHumanIntegration: false, verifierDigest: verifier };

describe('explicit QA waiver stage', { skip }, () => {
  let db: Ledger;
  let closeDatabase: (() => Promise<void>) | undefined;
  let settleExplicitQaWaiver: typeof import('../src/quality.ts').settleExplicitQaWaiver;
  let explicitQaWaiverStageReady: typeof import('../src/quality.ts').explicitQaWaiverStageReady;
  let authorizeExplicitQaWaiver: typeof import('../src/quality.ts').authorizeExplicitQaWaiver;
  let expectedArtifactRisk: typeof import('../src/quality.ts').expectedArtifactRisk;
  let QualityPolicies: typeof import('../src/quality-policy.ts').QualityPolicies;
  let ProjectTemplates: typeof import('../src/project-templates.ts').ProjectTemplates;
  let Quality: typeof import('../src/quality.ts').Quality;

  test.before(async () => {
    const base = process.env.AC_TEST_DATABASE_URL;
    if (!base) throw new Error('ISOLATED_DATABASE_REQUIRED');
    ({ settleExplicitQaWaiver, explicitQaWaiverStageReady, authorizeExplicitQaWaiver, expectedArtifactRisk, Quality } = await import('../src/quality.ts'));
    ({ QualityPolicies } = await import('../src/quality-policy.ts'));
    ({ ProjectTemplates } = await import('../src/project-templates.ts'));
    const { Ledger } = await import('../src/ledger.ts');
    const fixture = await isolatedDatabase(base, 'qawaiver');
    closeDatabase = fixture.close;
    db = new Ledger(fixture.url);
    await db.migrate();
  });
  test.after(async () => {
    await db?.close();
    await closeDatabase?.();
  });

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

  async function artifact(env: Awaited<ReturnType<typeof project>>, commit: string, evidence: readonly { kind: 'qa' | 'review'; status: string }[] = []) {
    const intentId = randomUUID();
    const operationId = randomUUID();
    const tree = 'd'.repeat(40);
    const base = 'c'.repeat(40);
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

  test('signed control authorizes only an owner and deduplicates delivery',async()=>{
    const env=await project('signed-owner-'+randomUUID()),control=new Control(db),operators=new Operators(db);
    const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id as string;
    const signer=async(principal:string)=>{
      await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
      const deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
      await operators.enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
      return (command:Record<string,unknown>)=>{
        const data={deviceId,expiresAt:Date.now()+120000};
        return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,command,data,installation)),keys.privateKey).toString('hex')};
      };
    };
    const proof=await signer(env.owner);
    const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:env.context,action:'qa.waiver.authorize' as const,payload:env.binding};
    const first=await control.execute(env.owner,command,proof(command));
    assert.deepEqual(await control.execute(env.owner,command,proof(command)),first);
    const repeated={...command,deliveryAttemptId:randomUUID()};
    assert.deepEqual(await control.execute(env.owner,repeated,proof(repeated)),first);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waiver_authorizations WHERE project_id=$1',[env.id])).rows[0].n,1);
    const authorizationId=(first.result as {authorizationId:string}).authorizationId;
    const revoke={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:env.context,action:'qa.waiver.revoke' as const,payload:{authorizationId}};
    const revoked=await control.execute(env.owner,revoke,proof(revoke));
    assert.deepEqual(revoked.result,{authorizationId,revoked:true});
    assert.deepEqual(await control.execute(env.owner,revoke,proof(revoke)),revoked);
    const revokeAgain={...revoke,intentId:randomUUID(),deliveryAttemptId:randomUUID()};
    assert.deepEqual((await control.execute(env.owner,revokeAgain,proof(revokeAgain))).result,revoked.result);
    assert.deepEqual(await control.execute(env.owner,repeated,proof(repeated)),first);
    const newAuthorization={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID()};
    await assert.rejects(control.execute(env.owner,newAuthorization,proof(newAuthorization)),(error:unknown)=>error instanceof Refusal&&error.code==='QA_WAIVER_AUTHORIZATION_REVOKED');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waiver_revocations WHERE authorization_id=$1',[authorizationId])).rows[0].n,1);
    const viewer='signed-viewer-'+randomUUID();await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[env.id,viewer]);
    const viewerProof=await signer(viewer),forbidden={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID()};
    await assert.rejects(control.execute(viewer,forbidden,viewerProof(forbidden)),(error:unknown)=>error instanceof Refusal&&error.code==='CONTEXT_FORBIDDEN');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waiver_authorizations WHERE project_id=$1',[env.id])).rows[0].n,1);
  });

  test('the QA settlement records not_required for one artifact and blocks failed evidence', async () => {
    const env = await project('stage-owner');
    await db.tx(c => authorizeExplicitQaWaiver(c, env.owner, env.context, env.binding));
    const plain = randomUUID();
    assert.equal(await db.tx(c => expectedArtifactRisk(c, plain, env.context, env.revision)), 'high');
    const passed = [{ kind: 'review' as const, status: 'passed' }];
    const artifactId = await artifact(env, 'b'.repeat(40), passed);
    assert.equal((await db.tx(c => settleExplicitQaWaiver(c, { contextId: env.context, artifactId, taskId: 'docs', correctionRevision: 0 }))).disposition, 'run');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers WHERE artifact_id=$1', [artifactId])).rows[0].n, 0);
    await new ProjectTemplates(db).apply(env.owner, env.context, { templateId: env.binding.templateId, revision: env.binding.templateRevision, expectedRevision: env.binding.templateRevision, expectedContextRevision: 0 });
    const view=await new Control(db).view(env.owner,env.context);
    assert.equal(view.qaWaiver.active?.templateId,env.binding.templateId);
    assert.equal(view.qaWaiver.active?.policyRevision,env.binding.policyRevision);
    assert.equal(view.qaWaiver.authorizations[0]?.taskId,'docs');
    const viewer='qa-viewer-'+randomUUID();
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[env.id,viewer]);
    const readonly=await new Control(db).view(viewer,env.context);
    assert.equal(readonly.qaWaiver.canAuthorize,false);
    assert.equal(readonly.qaWaiver.authorizations.length,0);
    const first = await db.tx(c => settleExplicitQaWaiver(c, { contextId: env.context, artifactId, taskId: 'docs', correctionRevision: 0 }));
    assert.equal(first.disposition, 'not_required');
    if (first.disposition !== 'not_required') return;
    assert.equal(first.receipt.qaWaiver.artifactId, artifactId);
    assert.equal((await db.tx(c => settleExplicitQaWaiver(c, { contextId: env.context, artifactId, taskId: 'docs', correctionRevision: 0 }))).disposition, 'not_required');
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_verification_evidence WHERE artifact_id=$1 AND kind='qa'", [artifactId])).rows[0].n, 0);
    assert.equal(await db.tx(c => explicitQaWaiverStageReady(c, env.context, artifactId)), true);
    const quality = new Quality(db, randomBytes(32), { identity: async () => { throw new Error('unused'); } });
    assert.equal((await db.tx(c => quality.assertReady(c, artifactId, env.authority))).id, artifactId);

    const successor = await artifact(env, 'e'.repeat(40), passed);
    assert.equal(await db.tx(c => explicitQaWaiverStageReady(c, env.context, successor)), false);
    await assert.rejects(db.tx(c => quality.assertReady(c, successor, env.authority)), (error: unknown) => error instanceof Refusal && error.code === 'QA_MISSING');
    assert.equal((await db.tx(c => settleExplicitQaWaiver(c, { contextId: env.context, artifactId: successor, taskId: 'docs', correctionRevision: 0 }))).disposition, 'not_required');

    const correction = await artifact(env, 'f'.repeat(40));
    assert.equal((await db.tx(c => settleExplicitQaWaiver(c, { contextId: env.context, artifactId: correction, taskId: 'docs', correctionRevision: 1 }))).disposition, 'run');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers WHERE artifact_id=$1', [correction])).rows[0].n, 0);
    for (const status of ['failed', 'canceled', 'missing_result', 'stale'] as const) {
      const blocked = await artifact(env, digest(status).slice(0, 40), [{ kind: 'qa', status }]);
      assert.equal((await db.tx(c => settleExplicitQaWaiver(c, { contextId: env.context, artifactId: blocked, taskId: 'docs', correctionRevision: 0 }))).disposition, 'blocked');
      assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers WHERE artifact_id=$1', [blocked])).rows[0].n, 0);
    }
    const authorizationId=first.receipt.qaWaiver.authorizationId;
    const {revokeExplicitQaWaiver}=await import('../src/quality.ts');
    const held=await db.pool.connect(), contender=await db.pool.connect();
    try{
      await held.query('BEGIN');
      await quality.assertReady(held,artifactId,env.authority);
      await contender.query('BEGIN');
      await contender.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(revokeExplicitQaWaiver(contender,env.owner,env.context,{authorizationId}),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await contender.query('ROLLBACK');
      await held.query('ROLLBACK');
    }finally{held.release();contender.release();}
    await db.tx(c=>revokeExplicitQaWaiver(c,env.owner,env.context,{authorizationId}));
    assert.equal((await new Control(db).view(env.owner,env.context)).qaWaiver.authorizations[0].revoked,true);
    assert.equal(await db.tx(c=>explicitQaWaiverStageReady(c,env.context,artifactId)),false);
    await assert.rejects(db.tx(c=>quality.assertReady(c,artifactId,env.authority)),(error:unknown)=>error instanceof Refusal&&error.code==='QA_MISSING');
    assert.equal((await db.tx(c=>settleExplicitQaWaiver(c,{contextId:env.context,artifactId,taskId:'docs',correctionRevision:0}))).disposition,'run');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers WHERE artifact_id=$1',[artifactId])).rows[0].n,1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_verification_evidence WHERE artifact_id=$1 AND kind='qa'",[artifactId])).rows[0].n,0);
    await assert.rejects(db.pool.query('DELETE FROM ac_qa_waiver_revocations WHERE authorization_id=$1',[authorizationId]));
  });
});
