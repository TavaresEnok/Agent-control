import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Capacity} from '../src/capacity.ts';
import {digest, Id} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {attestDistinctExamSessions, attestExamExecution, examSessionFor, examSubjectDigest,
  type ExamExecutionIdentity} from '../src/module-exam-sessions.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const base = process.env.AC_TEST_DATABASE_URL;

test('a sessão derivada do assunto é um UUID válido, estável e distinto por arquivo e por job', () => {
  const job = randomUUID();
  const subject = (file: string, line?: number) => examSubjectDigest({purpose: line ? 'reviewer' : 'examiner', module: 'qa',
    intentId: '00000000-0000-4000-8000-000000000001', commit: 'a'.repeat(40), file, ...(line ? {line} : {})});
  const session = examSessionFor(job, subject('a.ts'));
  assert.ok(Id.safeParse(session).success);
  assert.equal(session, examSessionFor(job, subject('a.ts')));
  assert.notEqual(session, examSessionFor(job, subject('b.ts')));
  assert.notEqual(session, examSessionFor(randomUUID(), subject('a.ts')));
  assert.notEqual(subject('a.ts', 3), subject('a.ts', 4));
  assert.notEqual(subject('a.ts'), subject('a.ts', 1));
  assert.throws(() => examSessionFor('não-uuid', subject('a.ts')));
});

test('o host recusa job de outro arquivo, conta posterior da cadeia e histórico incompleto', {skip: !base}, async () => {
  const fixture = await isolatedDatabase(base!, 'sessbind'), db = new Ledger(fixture.url);
  try {
    await db.migrate();
    const capacity = new Capacity(db), principal = 'binding-' + randomUUID(), project = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'binding']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const primary = randomUUID(), later = randomUUID();
    for (const [id, label] of [[primary, 'max'], [later, 'pro']] as const) {
      await capacity.addAccount(principal, project, {id, provider: 'claude', label, resourceIdentity: 'claude:' + digest(id),
        mode: 'subscription_cli', eligibility: 'documented_supported', eligibilitySource: 'synthetic://binding', maxConcurrent: 2});
    }
    const profile = async (account: string, model: string, effort: string) => {
      const id = randomUUID();
      await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,$3,$4,'specialist',true)",
        [id, account, model, effort]);
      return id;
    };
    const sonnet = await profile(primary, 'claude-sonnet-5-5', 'medium');
    const opus = await profile(primary, 'claude-opus-5-5', 'medium');
    const opusLater = await profile(later, 'claude-opus-5-5', 'medium');
    const policy = async (revision: number, regular: string[], emergency: string[]) => db.pool.query(
      'INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,$2,$3,$4,$5)',
      [project, revision, digest({revision}), JSON.stringify({roles: {specialist: {regular, emergency}}}), principal]);
    // Revision 1 puts the Max account first. Revision 2, published later, puts the Pro account first.
    await policy(1, [sonnet, opus], [opusLater]);
    await policy(2, [opusLater], [sonnet, opus]);
    const contextId = await db.createContext(principal, project, randomUUID());
    const authority = await db.acquire(principal, contextId, randomUUID(), 'binding-manager', 60);
    const intent = await db.accept(principal, {schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId,
      policyRevision: 1, action: 'plan.start', payload: {workflow: 'baseline-synthetic-v1', messageRef: 'encrypted:fixture'}}, authority, 'api');
    const intentId = intent.id, commit = 'c'.repeat(40);
    const examinerSubject = (file: string) => examSubjectDigest({purpose: 'examiner', module: 'qa', intentId, commit, file});
    const reviewerSubject = (file: string, line: number) => examSubjectDigest({purpose: 'reviewer', module: 'qa', intentId, commit, file, line});

    // Completed specialist jobs as the supervisor journals them, each session derived by the host from its own subject.
    const job = async (input: {account: string; profile: string; model: string; subject: string; revision?: number;
      state?: 'completed' | 'failed'; session?: string}): Promise<ExamExecutionIdentity> => {
      const grantId = randomUUID(), jobId = randomUUID();
      const sessionId = input.session ?? examSessionFor(jobId, input.subject);
      await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,$9,1,$10,false,'released')`,
      [grantId, randomUUID(), intentId, contextId, authority.epoch, input.account, input.profile, project, input.revision ?? 1, digest(grantId)]);
      await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'specialist',$14)`,
      [jobId, grantId, intentId, contextId, authority.epoch, sessionId, input.account, input.profile, digest({p: input.profile}),
        'e'.repeat(64), 'f'.repeat(64), digest({jobId}), commit, input.state ?? 'completed']);
      return {provider: 'claude', model: input.model, accountId: input.account, profileId: input.profile, grantId, sessionId};
    };
    const examinerA = await job({account: primary, profile: sonnet, model: 'claude-sonnet-5-5', subject: examinerSubject('a.ts')});
    const examinerB = await job({account: primary, profile: sonnet, model: 'claude-sonnet-5-5', subject: examinerSubject('b.ts')});
    const reviewerA = await job({account: primary, profile: opus, model: 'claude-opus-5-5', subject: reviewerSubject('a.ts', 7)});
    const reviewerB = await job({account: primary, profile: opus, model: 'claude-opus-5-5', subject: reviewerSubject('b.ts', 7)});
    const pair = (examiner: ExamExecutionIdentity, reviewer: ExamExecutionIdentity, file = 'a.ts', line = 7) =>
      attestDistinctExamSessions(db.pool, {contextId, examiner, examinerIntentId: intentId, examinerSubject: examinerSubject(file),
        reviewer, reviewerIntentId: intentId, reviewerSubject: reviewerSubject(file, line)});

    assert.equal(await pair(examinerA, reviewerA), true);
    assert.equal(await pair(examinerB, reviewerB, 'b.ts'), true);
    // Session swap between two files of the same intent: either job read B, so A is refused.
    assert.equal(await pair(examinerA, reviewerB), false);
    assert.equal(await pair(examinerB, reviewerA), false);
    assert.equal(await pair(examinerA, reviewerA, 'a.ts', 8), false);
    // A claimed session that the host did not derive for this job is refused even if it is journaled.
    const unbound = await job({account: primary, profile: opus, model: 'claude-opus-5-5', subject: reviewerSubject('a.ts', 7),
      session: randomUUID()});
    assert.equal(await pair(examinerA, unbound), false);
    assert.equal(await pair(examinerA, {...reviewerA, sessionId: reviewerB.sessionId}), false);

    // The reviewer must be on the account the grant's policy chose: Opus medium on a later account of the chain fails.
    const laterReviewer = await job({account: later, profile: opusLater, model: 'claude-opus-5-5', subject: reviewerSubject('a.ts', 7)});
    assert.equal(await pair(examinerA, laterReviewer), false);
    // The grant's own revision decides, not the context's current one: a later revision that puts Pro first
    // neither invalidates a Max reviewer of revision 1 nor lets that later account replace it.
    await db.pool.query('UPDATE ac_contexts SET capacity_policy_revision=2 WHERE id=$1', [contextId]);
    assert.equal(await pair(examinerA, reviewerA), true);
    assert.equal(await pair(examinerA, laterReviewer), false);
    const laterUnderRevision2 = await job({account: later, profile: opusLater, model: 'claude-opus-5-5',
      subject: reviewerSubject('a.ts', 7), revision: 2});
    assert.equal(await pair(examinerA, laterUnderRevision2), true);
    const examinerUnderRevision2 = await job({account: primary, profile: sonnet, model: 'claude-sonnet-5-5',
      subject: examinerSubject('a.ts'), revision: 2});
    assert.equal(await pair(examinerUnderRevision2, reviewerA), false);

    // Examiner check before a recheck spends a reviewer seat.
    const examiner = (execution: ExamExecutionIdentity | null, file = 'a.ts') =>
      attestExamExecution(db.pool, {contextId, intentId, execution, subject: examinerSubject(file)});
    assert.equal(await examiner(examinerA), true);
    assert.equal(await examiner(examinerB), false);
    assert.equal(await examiner(examinerB, 'b.ts'), true);
    // Incomplete history: no session, no account, a failed job or a different intent never attests.
    const {sessionId: _session, ...withoutSession} = examinerA;
    assert.equal(await examiner(withoutSession), false);
    assert.equal(await examiner({...examinerA, accountId: null}), false);
    assert.equal(await examiner(null), false);
    const failed = await job({account: primary, profile: sonnet, model: 'claude-sonnet-5-5', subject: examinerSubject('a.ts'), state: 'failed'});
    assert.equal(await examiner(failed), false);
    assert.equal(await attestExamExecution(db.pool, {contextId, intentId: randomUUID(), execution: examinerA,
      subject: examSubjectDigest({purpose: 'examiner', module: 'qa', intentId: randomUUID(), commit, file: 'a.ts'})}), false);
  } finally {
    await db.close();
    await fixture.close();
  }
});
