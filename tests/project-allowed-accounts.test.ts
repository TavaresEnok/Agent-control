// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {AccountHomes} from '../src/account-homes.ts';
import {Capacity} from '../src/capacity.ts';
import {type Command, digest, Refusal} from '../src/contracts.ts';
import {resolvePersonalDesign} from '../src/design-command.ts';
import {designGrantEffort, designGrantProjectAccounts, requiredDesignProfile, reserveDesignModel} from '../src/design-model-reservation.ts';
import {prepareDesignSpecialist} from '../src/design-prepare.ts';
import {loadSpecialistExamPlan, reserveSpecialistExamSeat} from '../src/exam-provider.ts';
import {Ledger} from '../src/ledger.ts';
import {CLAUDE_QUOTA_RETRY_INTERVAL_MS} from '../src/module-exam.ts';
import {
  composePersonalModuleExamRuntime,
  createModuleExamReservations,
  type ModuleExamClock,
  type ModuleExamRuntime,
} from '../src/module-exam-native.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {designCliFailureText} from '../src/personal-design-cli.ts';
import {moduleCliFailureText, runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {
  personalProjectContasFailureText,
  runPersonalProjectContasCli,
} from '../src/personal-project-add.ts';
import {verifyCliFailureText} from '../src/personal-verify-cli.ts';
import {resolvePersonalVerification} from '../src/verify-command.ts';
import {reservePersonalRecheckReviewer} from '../src/verify-native-launch.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {createModuleExamFixture, moduleExamFixtureAnswer} from './fixtures/module-exam-native.ts';
import {qaStaticTool} from './fixtures/module-exam-review.ts';

const base = process.env.AC_TEST_DATABASE_URL;

test('CLI --contas grava e remove allowedAccountIds com backup 0600 e recusa UUID inválido, duplicado, inexistente ou inativo', {
  skip: !base,
}, async () => {
  const database = await isolatedDatabase(base!, 'projcontas');
  const ledger = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-proj-contas-'));
  try {
    await ledger.migrate();
    const dataDirectory = join(root, 'data');
    const repo1 = join(root, 'repo1');
    const repo2 = join(root, 'repo2');
    for (const dir of [dataDirectory, repo1, repo2]) await mkdir(dir, {mode: 0o700});
    for (const repo of [repo1, repo2]) {
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, '-c', 'user.name=F', '-c', 'user.email=f@invalid', 'commit', '--allow-empty', '-m', 'init']);
    }

    const owner = 'contas-owner';
    const proj1 = randomUUID();
    const proj2 = randomUUID();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2),($3,$4)', [proj1, 'Principal', proj2, 'Secundario']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($3,$2,'owner')", [proj1, owner, proj2]);
    await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2),($3,$4)', [proj1, repo1, proj2, repo2]);
    await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");

    const capacity = new Capacity(ledger);
    const activeA = randomUUID();
    const activeB = randomUUID();
    const disabledC = randomUUID();
    for (const [id, label] of [[activeA, 'claude-a'], [activeB, 'claude-b'], [disabledC, 'claude-c']] as const) {
      await capacity.addAccount(owner, proj1, {
        id, provider: 'claude', label, resourceIdentity: `claude:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://contas', maxConcurrent: 2,
      });
    }
    const revC = Number((await ledger.pool.query('SELECT revision FROM ac_accounts WHERE id=$1', [disabledC])).rows[0].revision);
    await capacity.setEnabled(owner, proj1, 'account', {id: disabledC, enabled: false, expectedRevision: revC});

    const installationPath = join(dataDirectory, 'installation.json');
    await writeFile(installationPath, JSON.stringify({
      schemaVersion: 1,
      mode: 'administration-only',
      activation: 'personal',
      databaseUrl: database.url,
      dataDirectory,
      project: {id: proj1, label: 'Principal', repo: repo1, owner},
      projects: [{id: proj2, label: 'Secundario', repo: repo2, owner}],
      http: {listen: '127.0.0.1', port: 8765, publicOrigin: 'http://127.0.0.1:8765'},
    }, null, 2) + '\n', {mode: 0o600});
    await chmod(installationPath, 0o600);

    // 1) Recusa UUID inválido, duplicado, inexistente ou conta desabilitada.
    for (const [arg, code, pattern] of [
      ['nao-e-uuid', 'PROJECT_ACCOUNT_INVALID', /UUID/i],
      [`${activeA},${activeA}`, 'PROJECT_ACCOUNT_DUPLICATE', /repetido/i],
      [randomUUID(), 'PROJECT_ACCOUNT_INACTIVE', /está ativa/i],
      [disabledC, 'PROJECT_ACCOUNT_INACTIVE', /está ativa/i],
    ] as const) {
      await assert.rejects(
        () => runPersonalProjectContasCli(['--contas', installationPath, 'Principal', arg]),
        (err: unknown) => {
          assert.ok(err instanceof Refusal);
          assert.equal(err.code, code);
          assert.match(personalProjectContasFailureText(err), pattern);
          return true;
        },
      );
    }

    // 2) Grava lista de contas no projeto principal por rótulo e cria backup before-contas-<data>.
    const out1 = await runPersonalProjectContasCli(['--contas', installationPath, 'Principal', `${activeA},${activeB}`]);
    assert.match(out1.join('\n'), /Contas permitidas gravadas/);
    const saved1 = JSON.parse(await readFile(installationPath, 'utf8'));
    assert.deepEqual(saved1.project.allowedAccountIds, [activeA, activeB]);
    assert.equal(saved1.projects[0].allowedAccountIds, undefined);
    const backups1 = (await readdir(dataDirectory)).filter(name => name.startsWith('installation.json.before-contas-'));
    assert.equal(backups1.length, 1);

    // 3) Grava conta única no projeto secundário por UUID via scripts/personal-project.mjs --contas.
    const scriptPath = join(import.meta.dirname, '..', 'scripts', 'personal-project.mjs');
    const cliStdout = execFileSync(process.execPath, [scriptPath, '--contas', installationPath, proj2, activeB], {
      encoding: 'utf8',
    });
    assert.match(cliStdout, /Contas permitidas gravadas/);
    const saved2 = JSON.parse(await readFile(installationPath, 'utf8'));
    assert.deepEqual(saved2.project.allowedAccountIds, [activeA, activeB]);
    assert.deepEqual(saved2.projects[0].allowedAccountIds, [activeB]);

    // 4) Remove restrição com --todas.
    const outClear = await runPersonalProjectContasCli(['--contas', installationPath, 'Principal', '--todas']);
    assert.match(outClear.join('\n'), /Todas as contas ativas/i);
    const saved3 = JSON.parse(await readFile(installationPath, 'utf8'));
    assert.equal(saved3.project.allowedAccountIds, undefined);
    assert.deepEqual(saved3.projects[0].allowedAccountIds, [activeB]);
  } finally {
    await ledger.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});

test(' caminhos de reserva (verify, exam-provider, design e módulos 2 a 9 com espera de cota) respeitam allowedAccountIds sem cair para outra conta', {
  skip: !base, timeout: 120_000,
}, async () => {
  const database = await isolatedDatabase(base!, 'allowpaths');
  const ledger = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-allow-paths-'));
  try {
    await ledger.migrate();
    const dataDirectory = join(root, 'data');
    const repo = join(root, 'repo');
    await mkdir(dataDirectory, {mode: 0o700});
    await mkdir(repo, {mode: 0o700});
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=F', '-c', 'user.email=f@invalid', 'commit', '--allow-empty', '-m', 'init']);

    const owner = 'allow-owner';
    const project = randomUUID();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Restrito']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
    await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
    await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");

    const capacity = new Capacity(ledger);
    await capacity.configure(owner, {programmingLimit: 4, evaluationLimit: 4});
    const roles = ['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge'] as const;
    await capacity.registerModel(owner, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'synthetic://allow',
    });
    await capacity.registerModel(owner, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium', 'high'], roles: ['specialist'], source: 'synthetic://module-exam',
    });
    await capacity.registerModel(owner, {
      provider: 'codex', model: 'gpt-6.2-sol', efforts: ['medium'], roles: [...roles], source: 'synthetic://allow',
    });

    // Conta A vem primeiro por ordem lexicográfica e na cadeia; Conta B é a única permitida pelo projeto.
    const accountA = `00000000-0000-4000-8000-${randomUUID().slice(24)}`;
    const accountB = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(24)}`;
    const codexAccount = randomUUID();
    for (const [id, provider, label] of [
      [accountA, 'claude', 'claude-a'],
      [accountB, 'claude', 'claude-b'],
      [codexAccount, 'codex', 'codex-a'],
    ] as const) {
      await capacity.addAccount(owner, project, {
        id, provider, label, resourceIdentity: `${provider}:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://allow', maxConcurrent: 1,
      });
      await capacity.observeQuota(owner, id, {status: 'available', ttlSeconds: 3600, source: 'synthetic://allow'});
    }

    const addProf = async (accountId: string, model: string, effort: 'medium' | 'high') => {
      const id = randomUUID();
      await capacity.addProfile(owner, project, {id, accountId, model, effort, role: 'specialist'});
      return id;
    };
    const aOpusHigh = await addProf(accountA, 'claude-opus-5-5', 'high');
    const aSonnetMed = await addProf(accountA, 'claude-sonnet-5-5', 'medium');
    const aSonnetHigh = await addProf(accountA, 'claude-sonnet-5-5', 'high');
    const aOpusMed = await addProf(accountA, 'claude-opus-5-5', 'medium');

    const bOpusHigh = await addProf(accountB, 'claude-opus-5-5', 'high');
    const bSonnetMed = await addProf(accountB, 'claude-sonnet-5-5', 'medium');
    const bSonnetHigh = await addProf(accountB, 'claude-sonnet-5-5', 'high');
    const bOpusMed = await addProf(accountB, 'claude-opus-5-5', 'medium');
    const bReviewerSonnetMed = await addProf(accountB, 'claude-sonnet-5-5', 'medium');
    const codexProf = await addProf(codexAccount, 'gpt-6.2-sol', 'medium');

    // Política tem Conta A na frente em regular e emergency, seguida da Conta B e Codex.
    const rev = await capacity.publish(owner, project, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 2,
      maxEvaluatorsPerContext: 4,
      roles: {
        specialist: {
          regular: [aOpusHigh, aSonnetMed, aSonnetHigh, bOpusHigh, bSonnetMed, bSonnetHigh, codexProf],
          emergency: [aOpusMed, bReviewerSonnetMed, bOpusMed],
        },
      },
    });
    const context = await ledger.createContext(owner, project, randomUUID());
    await capacity.assignPolicy(owner, context, rev);
    const authority = await ledger.acquire(owner, context, randomUUID(), 'allow-test', 60);
    const openIntent = async () => {
      const cmd: Command = {
        schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(),
        contextId: context, policyRevision: rev, action: 'plan.start',
        payload: {workflow: 'baseline-synthetic-v1', messageRef: 'allow'},
      };
      return (await ledger.accept(owner, cmd, authority, 'api')).id;
    };
    const intentId = await openIntent();
    const release = async (grantId: string) =>
      capacity.transition(owner, grantId, authority, 'released', {processId: 'allow-test', state: 'not_started'});

    // --- 1) reserveSpecialistExamSeat & reservePersonalRecheckReviewer (personal:verify / exam-provider) ---
    // Sem restrição: escolhe Conta A (primeira da política).
    const unrestrictedExaminer = await reserveSpecialistExamSeat({
      capacity, ledger, principal: owner, authority, intentId, purpose: 'examiner',
      runtimeAccounts: [accountA, accountB], firstAccountOnly: true, releaseGrant: release,
    });
    assert.equal(unrestrictedExaminer.accountId, accountA);
    await release(unrestrictedExaminer.grantId);

    // Com restrição à Conta B: escolhe somente Conta B para examinador e revisor (mesmo com avoidAccountId/preferEmergencyFirst).
    const restrictedExaminer = await reserveSpecialistExamSeat({
      capacity, ledger, principal: owner, authority, intentId, purpose: 'examiner',
      runtimeAccounts: [accountA, accountB], projectAllowedAccounts: [accountB],
      firstAccountOnly: true, releaseGrant: release,
    });
    assert.equal(restrictedExaminer.accountId, accountB);
    await release(restrictedExaminer.grantId);

    const restrictedReviewer = await reservePersonalRecheckReviewer({
      ledger, principal: owner, authority, intentId,
      allowedAccounts: [accountB],
      exclusion: {avoidProfiles: [bSonnetMed], avoidAccounts: [accountB]},
      releaseGrant: id => release(id),
    });
    assert.equal(restrictedReviewer.accountId, accountB);
    await release(restrictedReviewer.grantId);

    // Quando Conta B está ocupada (maxConcurrent=1) e Conta A está livre: resulta em CAPACITY_BUSY, nunca Conta A!
    const holdB = await reserveSpecialistExamSeat({
      capacity, ledger, principal: owner, authority, intentId, purpose: 'examiner',
      runtimeAccounts: [accountA, accountB], projectAllowedAccounts: [accountB],
      firstAccountOnly: true, releaseGrant: release,
    });
    assert.equal(holdB.accountId, accountB);
    await assert.rejects(
      () => reserveSpecialistExamSeat({
        capacity, ledger, principal: owner, authority, intentId, purpose: 'reviewer',
        runtimeAccounts: [accountA, accountB], projectAllowedAccounts: [accountB],
        avoidAccountId: accountB, releaseGrant: release,
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'CAPACITY_BUSY',
    );
    await ledger.pool.query('DELETE FROM ac_capacity_waits');
    await release(holdB.grantId);

    // Quando Conta B está sem cota (exhausted) e Conta A está disponível: resulta em PROVIDER_USAGE_LIMIT, nunca Conta A!
    await capacity.observeQuota(owner, accountB, {status: 'exhausted', ttlSeconds: 3600, source: 'synthetic://allow'});
    await assert.rejects(
      () => reserveSpecialistExamSeat({
        capacity, ledger, principal: owner, authority, intentId, purpose: 'examiner',
        runtimeAccounts: [accountA, accountB], projectAllowedAccounts: [accountB],
        firstAccountOnly: true, releaseGrant: release,
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'PROVIDER_USAGE_LIMIT',
    );
    await assert.rejects(
      () => reservePersonalRecheckReviewer({
        ledger, principal: owner, authority, intentId,
        allowedAccounts: [accountB], releaseGrant: id => release(id),
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'PROVIDER_USAGE_LIMIT',
    );
    await capacity.observeQuota(owner, accountB, {status: 'available', ttlSeconds: 3600, source: 'synthetic://allow'});

    // Quando interseção com runtimeAccounts é vazia: recusa com PROJECT_ACCOUNTS_UNAVAILABLE.
    await assert.rejects(
      () => reserveSpecialistExamSeat({
        capacity, ledger, principal: owner, authority, intentId, purpose: 'examiner',
        runtimeAccounts: [accountA], projectAllowedAccounts: [accountB],
        firstAccountOnly: true, releaseGrant: release,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Refusal && err.code === 'PROJECT_ACCOUNTS_UNAVAILABLE');
        assert.match(verifyCliFailureText(err), /conta permitida/i);
        return true;
      },
    );

    // --- 2) Design (Módulo 10: preparar, exame, crítica visual, confirmação/revisor, criar) ---
    // requiredDesignProfile e reserveDesignModel para examiner, visual, reviewer e create:
    for (const [role, expectedProfile] of [
      ['examiner', bOpusHigh],
      ['visual', bOpusHigh],
      ['create', bOpusHigh],
      ['reviewer', bOpusMed],
    ] as const) {
      const prof = await requiredDesignProfile(ledger.pool, context, role, [accountB]);
      assert.equal(prof.account, accountB, `design role ${role} deve usar apenas accountB`);
      assert.equal(prof.id, expectedProfile);

      const seat = await reserveDesignModel(ledger, capacity, owner, authority, intentId, role, [accountB]);
      assert.equal(seat.accountId, accountB);
      assert.equal(seat.profileId, expectedProfile);
      // The grant records the project's restriction, so the launch check applies the same list again.
      const recorded = (await ledger.pool.query<{selection: unknown}>('SELECT selection FROM ac_capacity_grants WHERE id=$1', [seat.grantId])).rows[0]?.selection;
      assert.deepEqual(designGrantProjectAccounts(recorded), [accountB]);
      await release(seat.grantId);
    }
    // Without a project restriction the grant records none, and the launch check resolves the priority account as before.
    {
      const seat = await reserveDesignModel(ledger, capacity, owner, authority, intentId, 'examiner');
      const recorded = (await ledger.pool.query<{selection: unknown}>('SELECT selection FROM ac_capacity_grants WHERE id=$1', [seat.grantId])).rows[0]?.selection;
      assert.equal(designGrantProjectAccounts(recorded), undefined);
      await release(seat.grantId);
    }
    assert.equal(designGrantProjectAccounts({allowedAccounts: [accountB]}), undefined, 'the seat-level allowedAccounts is not the project restriction');
    // Esforço médio escolhido pelo projeto: exame e crítica visual usam o Opus médio, que pode estar só na cadeia de emergência.
    // A criação continua alta e o revisor continua médio. O grant registra o esforço para a checagem do lançamento.
    for (const [role, expectedProfile, recordedEffort] of [
      ['examiner', bOpusMed, 'medium'],
      ['visual', bOpusMed, 'medium'],
      ['create', bOpusHigh, undefined],
      ['reviewer', bOpusMed, undefined],
    ] as const) {
      const prof = await requiredDesignProfile(ledger.pool, context, role, [accountB], role === 'create' || role === 'reviewer' ? undefined : 'medium');
      assert.equal(prof.id, expectedProfile, `design role ${role} com esforço médio`);
      const seat = await reserveDesignModel(ledger, capacity, owner, authority, intentId, role, [accountB], undefined, 'medium');
      assert.equal(seat.profileId, expectedProfile);
      const recorded = (await ledger.pool.query<{selection: unknown}>('SELECT selection FROM ac_capacity_grants WHERE id=$1', [seat.grantId])).rows[0]?.selection;
      assert.equal(designGrantEffort(recorded), recordedEffort);
      await release(seat.grantId);
    }
    assert.equal(designGrantEffort({designEffort: 'ultra'}), undefined);
    assert.equal(designGrantProjectAccounts(null), undefined);

    // Design com Conta B ocupada -> CAPACITY_BUSY (nunca usa Conta A).
    const holdDesignB = await reserveDesignModel(ledger, capacity, owner, authority, intentId, 'examiner', [accountB]);
    assert.equal(holdDesignB.accountId, accountB);
    for (const role of ['examiner', 'visual', 'reviewer', 'create'] as const) {
      await assert.rejects(
        () => reserveDesignModel(ledger, capacity, owner, authority, intentId, role, [accountB]),
        (err: unknown) => err instanceof Refusal && err.code === 'CAPACITY_BUSY',
      );
      await ledger.pool.query('DELETE FROM ac_capacity_waits');
    }
    // Com --esperar-cota, outra rodada de design espera na fila, com o mesmo attemptId,
    // e recebe a vaga quando ela libera. Nunca cai para a Conta A.
    {
      const waitingIntent = await openIntent();
      let sleeps = 0;
      let clock = 0;
      const seat = await reserveDesignModel(ledger, capacity, owner, authority, waitingIntent, 'examiner', [accountB], {
        enabled: true,
        pollBackoff: true,
        deadlineAt: 60_000,
        now: () => clock,
        sleep: async ms => {
          sleeps += 1;
          clock += ms;
          const waits = (await ledger.pool.query<{n: string}>('SELECT count(*)::text AS n FROM ac_capacity_waits WHERE intent_id=$1', [waitingIntent])).rows[0]?.n;
          assert.ok(Number(waits) <= 1, 'uma linha de espera por reserva');
          if (sleeps === 2) await release(holdDesignB.grantId);
        },
      });
      assert.equal(seat.accountId, accountB);
      assert.ok(sleeps >= 2);
      await release(seat.grantId);
    }
    // Sem a espera, a recusa continua imediata.
    const holdAgain = await reserveDesignModel(ledger, capacity, owner, authority, intentId, 'examiner', [accountB]);
    const otherIntent = await openIntent();
    await assert.rejects(
      () => reserveDesignModel(ledger, capacity, owner, authority, otherIntent, 'examiner', [accountB]),
      (err: unknown) => err instanceof Refusal && err.code === 'CAPACITY_BUSY',
    );
    await ledger.pool.query('DELETE FROM ac_capacity_waits');
    await release(holdAgain.grantId);

    // Design com Conta B sem cota -> PROVIDER_USAGE_LIMIT (nunca usa Conta A).
    await capacity.observeQuota(owner, accountB, {status: 'exhausted', ttlSeconds: 3600, source: 'synthetic://allow'});
    for (const role of ['examiner', 'visual', 'reviewer', 'create'] as const) {
      await assert.rejects(
        () => reserveDesignModel(ledger, capacity, owner, authority, intentId, role, [accountB]),
        (err: unknown) => err instanceof Refusal && err.code === 'PROVIDER_USAGE_LIMIT',
      );
    }
    await capacity.observeQuota(owner, accountB, {status: 'available', ttlSeconds: 3600, source: 'synthetic://allow'});

    // Design com interseção vazia -> PROJECT_ACCOUNTS_UNAVAILABLE.
    await assert.rejects(
      () => requiredDesignProfile(ledger.pool, context, 'examiner', [randomUUID()]),
      (err: unknown) => {
        assert.ok(err instanceof Refusal && err.code === 'PROJECT_ACCOUNTS_UNAVAILABLE');
        assert.match(designCliFailureText(err), /conta permitida/i);
        return true;
      },
    );
    await assert.rejects(
      () => prepareDesignSpecialist({
        ledger, owner, projectId: project, apply: false,
        allowedAccountIds: [accountB], primaryAccountId: accountA,
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'PROJECT_ACCOUNTS_UNAVAILABLE',
    );
    const prepPreview = await prepareDesignSpecialist({
      ledger, owner, projectId: project, apply: false, allowedAccountIds: [accountB],
    });
    assert.equal(prepPreview.primaryAccountId, accountB);
    assert.ok(prepPreview.profiles.every(p => p.accountId === accountB));

    // --- 3) Módulos 2 a 9 (createModuleExamReservations + --esperar-cota) ---
    const supportedSeats = new Map<'claude' | 'codex', ReadonlySet<string>>([
      ['claude', new Set([accountA, accountB])],
      ['codex', new Set([codexAccount])],
    ]);
    const reservationsB = createModuleExamReservations({
      module: 'qa', ledger, principal: owner, authority, intentId,
      supportedSeats, allowedAccountIds: [accountB],
    });
    const modExaminerB = await reservationsB.reserve('examiner');
    assert.equal(modExaminerB.accountId, accountB);
    assert.equal(modExaminerB.profileId, bSonnetMed);
    await reservationsB.release(modExaminerB, 'not_started');

    const modHighRevB = await reservationsB.reserve('reviewer', modExaminerB, {
      source: 'examinador', severity: 'alta', fromExaminer: true,
    });
    assert.equal(modHighRevB.accountId, accountB);
    assert.equal(modHighRevB.profileId, bOpusMed);
    await reservationsB.release(modHighRevB, 'not_started');

    // Revisor comum (que exige outro provedor) com allowedAccountIds=[accountB] nunca usa codexAccount não permitida.
    // Sem outro provedor permitido, é falta de revisor (o achado fica provável e o exame segue), não falta de conta:
    // PROJECT_ACCOUNTS_UNAVAILABLE derrubava o módulo inteiro no primeiro achado revisado.
    await assert.rejects(
      () => reservationsB.reserve('reviewer', modExaminerB, {
        source: 'coletor', severity: 'media', fromExaminer: false,
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'MODULE_EXAM_REVIEWER_UNAVAILABLE',
    );

    // Com allowedAccountIds=[accountB, codexAccount], examinador usa accountB e revisor comum usa codexAccount (nunca accountA).
    const reservationsBCodex = createModuleExamReservations({
      module: 'qa', ledger, principal: owner, authority, intentId,
      supportedSeats, allowedAccountIds: [accountB, codexAccount],
    });
    const modRegularRevCodex = await reservationsBCodex.reserve('reviewer', modExaminerB, {
      source: 'coletor', severity: 'media', fromExaminer: false,
    });
    assert.equal(modRegularRevCodex.accountId, codexAccount);
    await reservationsBCodex.release(modRegularRevCodex, 'not_started');

    // Quando Conta B está ocupada ou sem cota, createModuleExamReservations recusa com CAPACITY_BUSY / PROVIDER_USAGE_LIMIT.
    const heldModB = await reservationsB.reserve('examiner');
    await assert.rejects(
      () => reservationsB.reserve('examiner'),
      (err: unknown) => err instanceof Refusal && err.code === 'CAPACITY_BUSY',
    );
    await ledger.pool.query('DELETE FROM ac_capacity_waits');
    await reservationsB.release(heldModB, 'not_started');

    await capacity.observeQuota(owner, accountB, {status: 'exhausted', ttlSeconds: 3600, source: 'synthetic://allow'});
    await assert.rejects(
      () => reservationsB.reserve('examiner'),
      (err: unknown) => err instanceof Refusal && err.code === 'PROVIDER_USAGE_LIMIT',
    );
    await capacity.observeQuota(owner, accountB, {status: 'available', ttlSeconds: 3600, source: 'synthetic://allow'});

    // Quando interseção com runtime é vazia para examinador: PROJECT_ACCOUNTS_UNAVAILABLE.
    await assert.rejects(
      () => createModuleExamReservations({
        module: 'qa', ledger, principal: owner, authority, intentId,
        supportedSeats: new Map([['claude', new Set([accountA])]]),
        allowedAccountIds: [accountB],
      }).reserve('examiner'),
      (err: unknown) => {
        assert.ok(err instanceof Refusal && err.code === 'PROJECT_ACCOUNTS_UNAVAILABLE');
        assert.match(moduleCliFailureText(err, 'qa'), /conta permitida/i);
        return true;
      },
    );

    // --- 4) CLI de módulo com allowedAccountIds e --esperar-cota espera a conta permitida (Conta B) e nunca troca para Conta A ---
    await writeFile(join(repo, 'app.ts'), 'export const x = 1;\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=F', '-c', 'user.email=f@invalid', 'commit', '-m', 'add app']);

    let bQuotaHits = 1;
    const fixture = await createModuleExamFixture({
      root, repo, ledger, owner, project,
      answer(launch) {
        if (launch.provider === 'claude' && bQuotaHits > 0) {
          bQuotaHits -= 1;
          return {output: '', failureCode: 'PROVIDER_USAGE_LIMIT'};
        }
        return moduleExamFixtureAnswer(launch);
      },
    });
    try {
      const hostRoot = join(root, 'spool-b');
      const accountRoot = join(root, 'accounts-b');
      await mkdir(hostRoot, {mode: 0o700});
      await mkdir(accountRoot, {mode: 0o700});
      const image = 'sha256:' + 'd'.repeat(64);
      const signingKeyPem = generateKeyPairSync('ed25519').privateKey.export({format: 'pem', type: 'pkcs8'}).toString();
      const subjects = new Map<string, string>();
      for (const [accId, label] of [[accountA, 'a'], [accountB, 'b']] as const) {
        const subjectDigest = digest({provider: 'claude', subject: `sub-${label}`});
        subjects.set(accId, subjectDigest);
        await ledger.pool.query('UPDATE ac_accounts SET mode=$2, resource_identity=$3, max_concurrent=2 WHERE id=$1', [
          accId, 'subscription_cli', `claude:${subjectDigest}`,
        ]);
        await new AccountHomes(ledger, accountRoot, [repo]).initialize(owner, project, accId);
        await writeFile(join(accountRoot, accId, '.credentials.json'), JSON.stringify({
          claudeAiOauth: {accessToken: `tok-${label}`, refreshToken: `ref-${label}`, expiresAt: Date.now() + 3600_000},
        }), {mode: 0o600});
      }
      const claudeSupervisor = new NativeExecutionSupervisor(ledger, {
        id: 'allow-claude', provider: 'claude', workerImage: image, toolsImage: image,
        hostRoot, accountRoot, protectedRepositories: [repo], signingKeyPem,
        providerNetworkId: 'e'.repeat(64), socketPath: join(root, 'fixture-docker.sock'),
        accountSubjects: [
          {accountId: accountA, subjectDigest: subjects.get(accountA)!},
          {accountId: accountB, subjectDigest: subjects.get(accountB)!},
        ],
        workerEnv: [], toolsEnv: [],
      });
      const dualClaudeRuntime: ModuleExamRuntime = [
        {provider: 'claude', accountIds: new Set([accountA, accountB]), supervisor: claudeSupervisor},
      ];
      const qaCtx = (await ledger.ensureExamContext(owner, project, 'qa')).contextId;
      await capacity.assignPolicy(owner, qaCtx, rev);
      await ledger.releaseLease(authority);

      const installationPath = join(dataDirectory, 'installation.json');
      await writeFile(installationPath, JSON.stringify({
        schemaVersion: 1, mode: 'administration-only', activation: 'personal',
        databaseUrl: database.url, dataDirectory,
        project: {
          id: project, label: 'Restrito', repo, owner,
          allowedAccountIds: [accountB],
          economy: {map: true, measurement: true, batch: false, batchTokens: 40000, batchFiles: 8},
        },
        projects: [],
        http: {listen: '127.0.0.1', port: 8765, publicOrigin: 'http://127.0.0.1:8765'},
      }), {mode: 0o600});

      const waits: number[] = [];
      let nowMs = Date.parse('2026-11-22T03:00:00Z');
      const clock: ModuleExamClock = {
        now: () => nowMs,
        async sleep(ms) {
          waits.push(ms);
          nowMs += ms;
          await ledger.pool.query(
            `UPDATE ac_accounts SET exhausted_until = exhausted_until - ($1::bigint * interval '1 millisecond') WHERE exhausted_until IS NOT NULL`,
            [ms],
          );
          await ledger.pool.query(
            `UPDATE ac_quota_observations SET observed_at = observed_at - ($1::bigint * interval '1 millisecond'), expires_at = expires_at - ($1::bigint * interval '1 millisecond')`,
            [ms],
          );
        },
      };

      const logsBefore = fixture.docker.logs.length;
      const [runId] = await runPersonalModuleCli('qa', [installationPath, project, '--esperar-cota'], {
        collectorOutput: {coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'ok'}], findings: []},
        moduleExamRuntime: async () => dualClaudeRuntime,
        clock,
      });
      assert.ok(runId);
      assert.ok(waits.length > 0 && waits.every(w => w === CLAUDE_QUOTA_RETRY_INTERVAL_MS));
      const newLaunches = fixture.docker.logs.slice(logsBefore);
      assert.ok(newLaunches.length >= 2);
      const qaGrants = (await ledger.pool.query<{account_id: string}>(
        'SELECT account_id::text FROM ac_capacity_grants WHERE context_id=$1',
        [qaCtx],
      )).rows;
      assert.ok(qaGrants.length >= 2);
      assert.ok(qaGrants.every(g => g.account_id === accountB), 'todas as reservas durante e após espera de cota devem usar somente accountB');

      // --- 5) resolvePersonalVerification & resolvePersonalDesign intersectam runtime e allowedAccountIds ---
      const onlyASupervisor = new NativeExecutionSupervisor(ledger, {
        id: 'only-a', provider: 'claude', workerImage: image, toolsImage: image,
        hostRoot, accountRoot, protectedRepositories: [repo], signingKeyPem,
        providerNetworkId: 'e'.repeat(64), socketPath: join(root, 'fixture-docker.sock'),
        accountSubjects: [{accountId: accountA, subjectDigest: subjects.get(accountA)!}],
        workerEnv: [], toolsEnv: [],
      });
      await assert.rejects(
        () => resolvePersonalVerification([installationPath, project], {
          composeRuntime: async () => ({executions: [onlyASupervisor]} as never),
        }),
        (err: unknown) => err instanceof Refusal && err.code === 'PROJECT_ACCOUNTS_UNAVAILABLE',
      );
      await assert.rejects(
        () => resolvePersonalDesign([], {
          installationPath, projectId: project,
          composeRuntime: async () => ({executions: [onlyASupervisor]} as never),
        }),
        (err: unknown) => err instanceof Refusal && err.code === 'PROJECT_ACCOUNTS_UNAVAILABLE',
      );
      const designCtx = (await ledger.ensureExamContext(owner, project, 'design')).contextId;
      await capacity.assignPolicy(owner, designCtx, rev);
      const resolvedDesign = await resolvePersonalDesign([], {
        installationPath, projectId: project,
        composeRuntime: async () => ({executions: [claudeSupervisor]} as never),
      });
      try {
        const dSeat = await resolvedDesign.reserve('specialist');
        assert.equal(dSeat.accountId, accountB);
        await resolvedDesign.release(dSeat);
      } finally {
        await resolvedDesign.close();
      }
    } finally {
      await fixture.docker.close();
    }
  } finally {
    await ledger.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});
