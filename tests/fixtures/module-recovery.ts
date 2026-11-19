import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../../src/ledger.ts';
import type {VerificationModuleRunInput} from '../../src/verification-modules.ts';
import {isolatedDatabase} from './isolated-database.ts';

export async function withModuleRecoveryFixture(
  databaseUrl: string, run: (input: VerificationModuleRunInput) => Promise<void>,
): Promise<void> {
  const database = await isolatedDatabase(databaseUrl, 'modulecleanup');
  const ledger = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-module-recovery-'));
  try {
    const repoPath = join(root, 'repo');
    const dataDirectory = join(root, 'data');
    await mkdir(repoPath);
    await mkdir(dataDirectory);
    await writeFile(join(repoPath, 'fixture.txt'), 'synthetic\n');
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repoPath, ...args],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    git('init');
    git('add', 'fixture.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'synthetic');
    const commit = git('rev-parse', 'HEAD');
    const projectId = randomUUID();
    const principal = 'synthetic-owner';
    await ledger.migrate();
    await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Fixture']);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [projectId, repoPath]);
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await ledger.createContext(principal, projectId, randomUUID());
    const {contextId} = await ledger.ensureExamContext(principal, projectId, 'qa');
    const authority = await ledger.acquire(principal, contextId, randomUUID(), 'synthetic-recovery', 60);
    await run({module: 'qa', ledger, principal, authority, projectId, repoPath, dataDirectory, commit});
  } finally {
    await ledger.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
}
