// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import pg from 'pg';
import {Capacity} from '../src/capacity.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {beginPersonalVerification} from '../src/verify-command.ts';
import {secretPreview} from '../src/verify-redact.ts';
import type {VerifyWorker} from '../src/verify-types.ts';

const exec = promisify(execFile);
const OWNED_DATABASE = 'ac_implementation_test_vordem5_m2';
const CLAUDE_LOGIN = 'M2claudeLoginValueXXX';
const SIBLING_LOGIN = 'M2grokLoginValueYYYYY';
const PARENT_LOGIN = 'M2parentFolderValueZZ';

function masked(secret: string): string {
  const preview = secretPreview(secret);
  return `${preview.preview} (sha256:${preview.sha256})`;
}

async function withAdmin(url: string, run: (query: (sql: string, params?: readonly unknown[]) => Promise<unknown>) => Promise<void>): Promise<void> {
  const client = new pg.Client({connectionString: url});
  await client.connect();
  try {
    await run((sql, params) => client.query(sql, params as never[]));
  } finally {
    await client.end();
  }
}

async function ownedDatabase(): Promise<{url: string; close: () => Promise<void>}> {
  const base = process.env.AC_TEST_DATABASE_URL?.trim() || (await readFile('/tmp/ac-vordem5-base-url', 'utf8')).trim();
  const adminUrl = new URL(base);
  const baseName = decodeURIComponent(adminUrl.pathname.replace(/^\//, ''));
  if (baseName === 'ac_ispagent' || baseName === 'ac_personal' || !['127.0.0.1', 'localhost'].includes(adminUrl.hostname)) {
    throw new Error('REFUSED_DATABASE');
  }
  const drop = async () => {
    await withAdmin(adminUrl.href, async query => {
      await query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [OWNED_DATABASE]);
      await query(`DROP DATABASE IF EXISTS "${OWNED_DATABASE}"`);
    });
  };
  await drop();
  await withAdmin(adminUrl.href, async query => {
    await query(`CREATE DATABASE "${OWNED_DATABASE}"`);
  });
  const owned = new URL(adminUrl.href);
  owned.pathname = `/${OWNED_DATABASE}`;
  return {url: owned.href, close: drop};
}

async function writeLogin(path: string, secret: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, `${JSON.stringify({login: secret})}\n`, {encoding: 'utf8', mode: 0o600});
  await chmod(path, 0o600);
}

async function reportBlob(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) parts.push(await readFile(full, 'utf8'));
    }
  };
  await walk(root);
  return parts.join('\n');
}

test('login da conta reservada sai mascarado e o da conta irmã permanece', {timeout: 180_000}, async () => {
  const database = await ownedDatabase();
  const db = new Ledger(database.url);
  const capacity = new Capacity(db);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-repo-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  const accounts = await mkdtemp(join(tmpdir(), 'ac-verify-accounts-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-bases-'));
  const image = `sha256:${'ab'.repeat(32)}`;
  let observed: Promise<void> | undefined;
  let examAccountId = '';
  try {
    await db.migrate();
    const principal = 'verify-owner';
    const project = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Verificação']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 2});
    await capacity.registerModel(principal, {provider: 'claude', model: 'fixture-model', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verify-account-secrets'});
    const labels = ['claude-a', 'claude-b'] as const;
    const accountIds = labels.map(() => randomUUID());
    const specialistProfiles = labels.map(() => randomUUID());
    const reviewerProfiles = labels.map(() => randomUUID());
    const adapters = labels.map(label => createSyntheticProviderAdapter({
      id: 'fixture-' + label,
      provider: 'claude',
      version: 'verify-v1',
      runner: async input => ({protocol: 'ac-synthetic-quota-v1', provider: 'claude', accountId: input.accountId, status: 'available', remainingPercent: 75, resetAt: null}),
    }));
    const collectors = new ProviderCollectors(db, adapters);
    for (let i = 0; i < labels.length; i++) {
      await capacity.addAccount(principal, project, {id: accountIds[i], provider: 'claude', label: 'Synthetic ' + labels[i], resourceIdentity: 'verify-' + accountIds[i], mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-account-secrets', maxConcurrent: 2});
      await capacity.addProfile(principal, project, {id: specialistProfiles[i], accountId: accountIds[i], model: 'fixture-model', effort: 'medium', role: 'specialist'});
      await capacity.addProfile(principal, project, {id: reviewerProfiles[i], accountId: accountIds[i], model: 'fixture-model', effort: 'medium', role: 'reviewer'});
      await collectors.bind(principal, project, {accountId: accountIds[i], adapterId: adapters[i].manifest.id, expectedRevision: 0, minimumIntervalSeconds: 1});
    }
    const revision = await capacity.publish(principal, project, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 1,
      roles: {specialist: {regular: specialistProfiles, emergency: []}, reviewer: {regular: reviewerProfiles, emergency: []}},
    });
    const context = await db.createContext(principal, project, randomUUID());
    await capacity.assignPolicy(principal, context, revision);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");
    for (const accountId of accountIds) await collectors.collect(principal, project, accountId, randomUUID());
    await writeLogin(join(accounts, accountIds[0]!, '.credentials.json'), CLAUDE_LOGIN);
    await writeLogin(join(accounts, accountIds[1]!, '.credentials.json'), SIBLING_LOGIN);
    await writeLogin(join(accounts, '.credentials.json'), PARENT_LOGIN);
    await mkdir(join(repo, 'src'), {recursive: true});
    await writeFile(join(repo, 'src', 'app.ts'), "export function register(app: {get(path: string, handler: () => string): void}) {\n  app.get('/admin', () => 'painel');\n}\n");
    const gitEnv = {...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.com'};
    await exec('git', ['init'], {cwd: repo, env: gitEnv});
    await exec('git', ['add', 'src/app.ts'], {cwd: repo, env: gitEnv});
    await exec('git', ['-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'rota sem checagem'], {cwd: repo, env: gitEnv});
    const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo})).stdout.trim();
    const authority = await db.acquire(principal, context, randomUUID(), 'verify-account-secrets', 60);
    const worker: VerifyWorker = {
      async run(call) {
        const task = call.task;
        if (task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: ['http']});
        if (task.startsWith('Pedido de exame.')) {
          examAccountId = call.accountId;
          const items = (task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
          return JSON.stringify({
            kind: 'exame',
            filesRead: ['src/app.ts'],
            checklist: items.length ? items : ['SEM-ITEM'],
            findings: [{
              title: 'Rota sem checagem de acesso',
              severity: 'alta',
              file: 'src/app.ts',
              line: 2,
              scenario: 'A rota responde sem dono.',
              suggestion: 'Checar o acesso antes de responder.',
              cwe: 'CWE-862',
              reference: 'ASVS-5.0-V4',
              snippet: `login ${CLAUDE_LOGIN} ${SIBLING_LOGIN} ${PARENT_LOGIN}`,
            }],
          });
        }
        if (task.startsWith('Pedido de confirmação.')) {
          return JSON.stringify({
            kind: 'confirmacao',
            status: 'confirmado',
            reason: 'A rota responde sem checar o dono.',
            proof: 'src/app.ts registra GET /admin sem checagem.',
          });
        }
        throw new Error('task desconhecida');
      },
    };
    const begun = await beginPersonalVerification({
      projectId: project,
      dataDirectory,
      repoPath: repo,
      commit,
      ledger: db,
      principal,
      authority,
      policyRevision: 1,
      worker,
      databasesDirectory: databases,
      image,
      accountRoot: accounts,
      runTools: async () => {},
      observe: job => { observed = job; },
    });
    assert.ok(observed);
    await observed;
    assert.ok(examAccountId === accountIds[0] || examAccountId === accountIds[1]);
    const reservedSecret = examAccountId === accountIds[0] ? CLAUDE_LOGIN : SIBLING_LOGIN;
    const siblingSecret = examAccountId === accountIds[0] ? SIBLING_LOGIN : CLAUDE_LOGIN;
    const stored = (await db.pool.query<{payload: string; status: string; report_dir: string}>(
      `SELECT f.payload::text AS payload, r.status, r.report_dir
       FROM ac_verify_findings f JOIN ac_verify_runs r ON r.id=f.run_id WHERE f.run_id=$1`,
      [begun.id],
    )).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, 'done');
    const held = `${await reportBlob(stored[0]?.report_dir ?? '')}\n${stored[0]?.payload ?? ''}`;
    assert.equal(held.includes(reservedSecret), false, 'reserved login still present');
    assert.equal(held.includes(masked(reservedSecret)), true, 'reserved login mask missing');
    assert.equal(held.includes(siblingSecret), true, 'sibling login was redacted');
    assert.equal(held.includes(PARENT_LOGIN), true, 'parent login was redacted');
  } finally {
    await db.close();
    await database.close();
    await rm(repo, {recursive: true, force: true});
    await rm(dataDirectory, {recursive: true, force: true});
    await rm(accounts, {recursive: true, force: true});
    await rm(databases, {recursive: true, force: true});
  }
});
