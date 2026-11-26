// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Capacity} from '../src/capacity.ts';
import {digest} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {examineFunctionalModule, type ModuleExamSeat} from '../src/module-exam.ts';
import {attestDistinctExamSessions, examFindingIdentity, examSessionFor, examSubjectDigest} from '../src/module-exam-sessions.ts';
import {recheckModuleFindings, runVerificationModule} from '../src/verification-modules.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {qaStaticTool, reviewFixtureVerdict, skipQuestion} from './fixtures/module-exam-review.ts';

const base = process.env.AC_TEST_DATABASE_URL;

test('a confirmação de um achado alto não vale para outro achado na mesma linha, na publicação e na rechecagem', {
  skip: !base, timeout: 90_000,
}, async () => {
  const database = await isolatedDatabase(base!, 'findbind');
  const ledger = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-finding-binding-'));
  try {
    await ledger.migrate();
    const dataDirectory = join(root, 'data');
    const repo = join(root, 'repo');
    await mkdir(dataDirectory, {mode: 0o700});
    await mkdir(repo, {mode: 0o700});
    const skipped = 'test.skip("valida pedido", () => {})';
    await writeFile(join(repo, 'app.test.ts'), `${skipped};\n`);
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
    const commitAll = (message: string) => {
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    git('init');
    const commit = commitAll('initial');

    const principal = 'finding-owner';
    const projectId = randomUUID();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Finding Binding']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [projectId, repo]);
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const account = randomUUID();
    await new Capacity(ledger).addAccount(principal, projectId, {id: account, provider: 'claude', label: 'max',
      resourceIdentity: 'claude:' + digest(account), mode: 'subscription_cli', eligibility: 'documented_supported',
      eligibilitySource: 'synthetic://finding-binding', maxConcurrent: 2});
    const profile = async (model: string) => {
      const id = randomUUID();
      await ledger.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,$3,'medium','specialist',true)",
        [id, account, model]);
      return id;
    };
    const sonnet = await profile('claude-sonnet-5-5');
    const opus = await profile('claude-opus-5-5');
    await ledger.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,$3,$4)',
      [projectId, digest({revision: 1}), JSON.stringify({roles: {specialist: {regular: [sonnet, opus], emergency: []}}}), principal]);
    await ledger.createContext(principal, projectId, randomUUID());
    const {contextId} = await ledger.ensureExamContext(principal, projectId, 'qa');
    const authority = await ledger.acquire(principal, contextId, randomUUID(), 'finding-binding', 60);

    // A completed native job as the supervisor journals it, its session derived by the host from the subject.
    const journal = async (seat: ModuleExamSeat, intentId: string, subject: string) => {
      const jobId = randomUUID();
      const sessionId = examSessionFor(jobId, subject);
      await ledger.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'specialist',$8,1,1,$9,false,'released')`,
      [seat.grantId, randomUUID(), intentId, contextId, authority.epoch, seat.accountId, seat.profileId, projectId, digest(seat.grantId)]);
      await ledger.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'specialist','completed')`,
      [jobId, seat.grantId, intentId, contextId, authority.epoch, sessionId, seat.accountId, seat.profileId, digest({p: seat.profileId}),
        'e'.repeat(64), 'f'.repeat(64), digest({jobId}), commit]);
      return sessionId;
    };
    const seat = (purpose: 'examiner' | 'reviewer'): ModuleExamSeat => ({provider: 'claude',
      model: purpose === 'examiner' ? 'claude-sonnet-5-5' : 'claude-opus-5-5', accountId: account,
      profileId: purpose === 'examiner' ? sonnet : opus, grantId: randomUUID()});

    // Two different high findings of the examiner on the same line of the same file.
    const highFindings = [
      {line: 1, snippet: skipped, hypothesis: skipQuestion, title: 'Teste pulado esconde regressão', severity: 'alta'},
      {line: 1, snippet: skipped, hypothesis: skipQuestion, title: 'Validação do pedido sem cobertura', severity: 'alta'},
    ];
    const publish = (tamper: (res: Awaited<ReturnType<typeof examineFunctionalModule>>) => void) => runVerificationModule({
      module: 'qa', ledger, principal, authority, projectId, repoPath: repo, dataDirectory, commit,
      collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
      async examinar(req) {
        const {intentId} = req;
        const res = await examineFunctionalModule({
          ...req, map: await mapModuleSnapshot(req.snapshot), commit,
          reserve: async purpose => seat(purpose),
          release: async () => {},
          worker: {
            async run(call) {
              const subject = (call as {examSubject?: string}).examSubject!;
              (call as {examSessionId?: string}).examSessionId = await journal(call as ModuleExamSeat, intentId, subject);
              const task = JSON.parse(call.task);
              if (task.checklist) {
                return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: ['app.test.ts'], checklist: ['qa'], findings: highFindings});
              }
              return JSON.stringify(reviewFixtureVerdict(task, skipped));
            },
          },
          attestSessions: ({examiner, reviewer, file, line, finding}) => attestDistinctExamSessions(ledger.pool, {
            contextId, examiner, examinerIntentId: intentId, reviewer, reviewerIntentId: intentId,
            examinerSubject: examSubjectDigest({purpose: 'examiner', module: 'qa', intentId, commit, file}),
            reviewerSubject: examSubjectDigest({purpose: 'reviewer', module: 'qa', intentId, commit, file, line, finding}),
          }),
        });
        tamper(res);
        return res;
      },
    });

    // Publication, positive path: each finding has its own attested reviewer and is confirmed.
    const confirmed = await publish(() => {});
    assert.deepEqual(confirmed.achados.map(item => [item.id, item.where.line, item.status, item.verifier?.model]), [
      ['ACH-001', 1, 'confirmado', 'claude-opus-5-5'],
      ['ACH-002', 1, 'confirmado', 'claude-opus-5-5'],
    ]);
    // Publication, swap: the two reviewer executions are exchanged between the findings of the same line.
    const swapped = await publish(res => {
      const [first, second] = res.findings;
      [first!.verifier, second!.verifier] = [second!.verifier, first!.verifier];
    });
    assert.deepEqual(swapped.achados.map(item => [item.id, item.status, item.verifier]), [
      ['ACH-001', 'provavel', null],
      ['ACH-002', 'provavel', null],
    ]);
    // Publication, one reviewer for both: the second finding gets the first finding's confirmation.
    const reused = await publish(res => { res.findings[1]!.verifier = res.findings[0]!.verifier; });
    assert.deepEqual(reused.achados.map(item => [item.id, item.status]), [['ACH-001', 'confirmado'], ['ACH-002', 'provavel']]);

    // Recheck after the commit changed: the line still holds the skipped test.
    await writeFile(join(repo, 'outro.ts'), 'export const valor = 1;\n');
    const head = commitAll('change');
    assert.notEqual(head, commit);
    const recheck = (runId: string, pick: (own: {seat: ModuleExamSeat; sessionId: string}, index: number,
      earlier: {seat: ModuleExamSeat; sessionId: string}[]) => {seat: ModuleExamSeat; sessionId: string}) => {
      const issued: {seat: ModuleExamSeat; sessionId: string}[] = [];
      return recheckModuleFindings(ledger, principal, authority, {
        module: 'qa', runId, achadoIds: ['ACH-001', 'ACH-002'], dataDirectory, projectId,
        async review(req) {
          assert.equal(req.commit, head);
          const own = seat('reviewer');
          const original = highFindings[issued.length]!;
          const expectedFinding = examFindingIdentity({
            id: ['ACH-001', 'ACH-002'][issued.length]!, source: 'examinador', file: 'app.test.ts',
            line: original.line, severity: original.severity, evidence: original.snippet, hypothesis: original.hypothesis,
          });
          const expectedSubject = examSubjectDigest({purpose: 'reviewer', module: 'qa', intentId: req.intentId,
            commit: head, file: 'app.test.ts', line: original.line, finding: expectedFinding});
          assert.equal(req.subject, expectedSubject);
          const sessionId = await journal(own, req.intentId, expectedSubject);
          const chosen = pick({seat: own, sessionId}, issued.length, issued);
          issued.push({seat: own, sessionId});
          const {grantId, ...identity} = chosen.seat;
          return {reviewer: {...identity, grantId, sessionId: chosen.sessionId},
            output: JSON.stringify(reviewFixtureVerdict(JSON.parse(req.task), skipped))};
        },
      });
    };
    // Recheck, positive path: each finding is reviewed by its own execution.
    const own = await recheck(confirmed.runId, mine => mine);
    assert.deepEqual(own.results, [{id: 'ACH-001', status: 'reaberto'}, {id: 'ACH-002', status: 'reaberto'}]);
    // Recheck, swap: the execution that confirmed ACH-001 is offered for ACH-002 on the same line.
    const exchanged = await recheck(reused.runId, (mine, index, earlier) => index === 1 ? earlier[0]! : mine);
    assert.deepEqual(exchanged.results, [
      {id: 'ACH-001', status: 'reaberto'},
      {id: 'ACH-002', status: 'pendente', reason: 'MODULE_EXAM_HIGH_SESSION_UNPROVEN'},
    ]);
  } finally {
    await ledger.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});
