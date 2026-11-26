// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Capacity} from '../src/capacity.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {beginPersonalVerification, examRunOptions} from '../src/verify-command.ts';
import {collectToolFindings} from '../src/verify-collect.ts';
import {deletedHistoryExcerpt, runSecurityVerification} from '../src/verify-runtime.ts';
import {listSecurityReports} from '../src/verify-report.ts';
import {planSecuritySlices} from '../src/verify-slices.ts';
import {loadSecurityChecklist} from '../src/verify-checklist.ts';
import type {ToolResult, VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const GIT_ENV = {...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.com'};

async function bootVerify(label: string) {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, label);
  const db = new Ledger(database.url);
  const capacity = new Capacity(db);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-repo-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-bases-'));
  await db.migrate();
  const principal = 'verify-owner';
  const project = randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Verificação']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
  await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 2});
  await capacity.registerModel(principal, {provider: 'claude', model: 'fixture-model', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verify-integrity'});
  const labels = ['claude-a', 'claude-b'] as const;
  const accounts = labels.map(() => randomUUID());
  const specialistProfiles = labels.map(() => randomUUID());
  const reviewerProfiles = labels.map(() => randomUUID());
  const adapters = labels.map(name => createSyntheticProviderAdapter({
    id: 'fixture-' + name,
    provider: 'claude',
    version: 'verify-v1',
    runner: async input => ({protocol: 'ac-synthetic-quota-v1', provider: 'claude', accountId: input.accountId, status: 'available', remainingPercent: 75, resetAt: null}),
  }));
  const collectors = new ProviderCollectors(db, adapters);
  for (let i = 0; i < labels.length; i++) {
    await capacity.addAccount(principal, project, {id: accounts[i], provider: 'claude', label: 'Synthetic ' + labels[i], resourceIdentity: 'verify-' + accounts[i], mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-integrity', maxConcurrent: 2});
    await capacity.addProfile(principal, project, {id: specialistProfiles[i], accountId: accounts[i], model: 'fixture-model', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: reviewerProfiles[i], accountId: accounts[i], model: 'fixture-model', effort: 'medium', role: 'reviewer'});
    await collectors.bind(principal, project, {accountId: accounts[i], adapterId: adapters[i].manifest.id, expectedRevision: 0, minimumIntervalSeconds: 1});
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
  for (const accountId of accounts) await collectors.collect(principal, project, accountId, randomUUID());
  const authority = await db.acquire(principal, context, randomUUID(), label, 60);
  return {
    db, repo, dataDirectory, databases, principal, project, authority,
    async close() {
      await db.close();
      await database.close();
      await rm(repo, {recursive: true, force: true});
      await rm(dataDirectory, {recursive: true, force: true});
      await rm(databases, {recursive: true, force: true});
    },
  };
}
type Ready = Awaited<ReturnType<typeof bootVerify>>;

async function blob(root: string): Promise<string> {
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

function filesOf(task: string): string[] {
  const lines = task.split('\n');
  const at = lines.findIndex(line => line === 'Arquivos:');
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) { if (!line.startsWith('- ')) break; out.push(line.slice(2)); }
  return out;
}

type Plan = {
  /** How many items of the planned list the examiner declares. Default: all of them. */
  declare?: number;
  findingIn?: (slice: string[]) => {file: string; line: number} | null;
  onMap?: () => Promise<void>;
  onConfirm?: (task: string) => void;
  /** Files the examiner leaves unjudged in its first multi-file call only. */
  unreadFirst?: string[];
};

function planned(plan: Plan = {}): {worker: VerifyWorker; tasks: string[]} {
  const tasks: string[] = [];
  let firstBatch = true;
  const worker: VerifyWorker = {
    async run(call) {
      tasks.push(call.task);
      if (call.task.startsWith('Pedido de mapa.')) {
        await plan.onMap?.();
        return JSON.stringify({kind: 'mapa', routes: [], surfaces: []});
      }
      if (call.task.startsWith('Pedido de exame.')) {
        const files = filesOf(call.task);
        const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        const first = firstBatch && files.length > 1;
        if (files.length > 1) firstBatch = false;
        const unread = new Set(first ? plan.unreadFirst ?? [] : []);
        const read = files.filter(file => !unread.has(file));
        const found = plan.findingIn?.(files) ?? null;
        return JSON.stringify({
          kind: 'exame',
          filesRead: read.length ? read : ['src/nunca.ts'],
          checklist: items.slice(0, plan.declare ?? items.length),
          findings: found ? [{
            title: `Achado em ${found.file}`, severity: 'media', file: found.file, line: found.line,
            scenario: 'Entrada sem validação.', suggestion: 'Validar.', cwe: 'CWE-20', reference: 'ASVS-5.0-V5', snippet: 'valor',
          }] : [],
        });
      }
      if (call.task.startsWith('Pedido de confirmação.')) {
        plan.onConfirm?.(call.task);
        return JSON.stringify({kind: 'confirmacao', status: 'confirmado', reason: 'Reproduz.', proof: 'visto'});
      }
      throw new Error('task inesperada');
    },
  };
  return {worker, tasks};
}

async function seed(repo: string, count: number) {
  await mkdir(join(repo, 'src'), {recursive: true});
  for (let index = 0; index < count; index += 1) await writeFile(join(repo, 'src', `m${String(index).padStart(2, '0')}.ts`), `export const v${index} = ${index};\n`);
}

function run(ready: Ready, worker: VerifyWorker, extra: Record<string, unknown> = {}) {
  return runSecurityVerification({ledger: ready.db, principal: ready.principal, authority: ready.authority, projectId: ready.project,
    repoPath: ready.repo, dataDirectory: ready.dataDirectory, commit: COMMIT, policyRevision: 1, worker, ...extra});
}

// ---------------------------------------------------------------- 1. identidade do código examinado

test('o exame inteiro lê o snapshot do commit, não o checkout editado antes, durante ou depois', {timeout: 180_000}, async () => {
  const ready = await bootVerify('integ_identity');
  let observed: Promise<void> | undefined;
  try {
    await mkdir(join(ready.repo, 'src'), {recursive: true});
    for (let index = 0; index < 20; index += 1) {
      const name = String(index).padStart(2, '0');
      await writeFile(join(ready.repo, 'src', `f${name}.ts`), `export const f${name} = 'COMMITTED-${name}';\n`);
    }
    await exec('git', ['init', '-q'], {cwd: ready.repo, env: GIT_ENV});
    await exec('git', ['add', '.'], {cwd: ready.repo, env: GIT_ENV});
    await exec('git', ['commit', '-q', '-m', 'vinte arquivos'], {cwd: ready.repo, env: GIT_ENV});
    const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: ready.repo})).stdout.trim();
    // Antes do exame: uma edição sem commit e um arquivo novo que o Git não conhece.
    await writeFile(join(ready.repo, 'src', 'f03.ts'), "export const f03 = 'EDITADO-ANTES';\n");
    await writeFile(join(ready.repo, 'src', 'extra.ts'), "export const extra = 'NAO-COMMITADO';\n");
    let snapshot = '';
    const confirmations: string[] = [];
    const {worker, tasks} = planned({
      findingIn: slice => (slice.includes('src/f03.ts') ? {file: 'src/f03.ts', line: 1} : null),
      // Durante o exame: mais uma edição, feita pelo próprio andamento do trabalho.
      onMap: async () => { await writeFile(join(ready.repo, 'src', 'f11.ts'), "export const f11 = 'EDITADO-DURANTE';\n"); },
      onConfirm: task => { confirmations.push(task); },
    });
    const calls: string[] = [];
    const wrapped: VerifyWorker = {async run(call) { calls.push(call.repo); return worker.run(call); }};
    const begun = await beginPersonalVerification({
      projectId: ready.project,
      dataDirectory: ready.dataDirectory,
      repoPath: ready.repo,
      commit,
      ledger: ready.db,
      principal: ready.principal,
      authority: ready.authority,
      policyRevision: 1,
      worker: wrapped,
      databasesDirectory: ready.databases,
      image: `sha256:${'ab'.repeat(32)}`,
      batch: {tokens: 40_000, files: 8},
      runTools: async spec => {
        assert.equal(spec.repository, ready.repo);
        snapshot = spec.snapshot ?? '';
        assert.notEqual(snapshot, '');
        assert.notEqual(snapshot, ready.repo);
        // A edição acontece depois do snapshot e antes do exame dos arquivos.
        await writeFile(join(ready.repo, 'src', 'f07.ts'), "export const f07 = 'EDITADO-NAS-FERRAMENTAS';\n");
        assert.equal(await readFile(join(snapshot, 'src', 'f07.ts'), 'utf8'), "export const f07 = 'COMMITTED-07';\n");
      },
      observe: job => { observed = job; },
    });
    assert.ok(observed);
    await observed;
    const [report] = await listSecurityReports(ready.dataDirectory, ready.project);
    assert.ok(report);
    assert.equal(report.id, begun.id);
    const directory = join(ready.dataDirectory, 'verificacoes', ready.project, report.directoryName);
    const raw = JSON.parse(await readFile(join(directory, 'bruto', 'achados-brutos.json'), 'utf8')) as {receipts: {files: {file: string; sha256: string | null}[]}[]};
    const hashes = new Map(raw.receipts.flatMap(receipt => receipt.files).map(item => [item.file, item.sha256]));
    const expected = (name: string) => createHash('sha256').update(`export const f${name} = 'COMMITTED-${name}';\n`).digest('hex');
    // A lista é a do commit: 20 arquivos, sem o arquivo novo.
    assert.equal(hashes.size, 20);
    assert.equal(hashes.has('src/extra.ts'), false);
    for (const name of ['03', '07', '11', '00', '19']) assert.equal(hashes.get(`src/f${name}.ts`), expected(name), `hash de f${name}`);
    const coverage = await readFile(join(directory, 'cobertura.md'), 'utf8');
    assert.equal(coverage.includes('src/extra.ts'), false);
    // O trecho que foi ao revisor é o commitado, não a edição local.
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0] ?? '', /COMMITTED-03/);
    assert.equal((confirmations[0] ?? '').includes('EDITADO'), false);
    assert.equal((await blob(directory)).includes('EDITADO'), false);
    // O revisor e o examinador são apontados para o snapshot, e ele some quando o job acaba.
    assert.ok(calls.length > 0);
    assert.ok(calls.every(repo => repo === snapshot));
    await assert.rejects(stat(snapshot), {code: 'ENOENT'});
    assert.ok(tasks.some(task => task.startsWith('Pedido de mapa.')));
  } finally {
    if (observed) await observed.catch(() => undefined);
    await ready.close();
  }
});

test('o histórico de arquivos apagados é o do commit admitido, não o do HEAD de agora', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-history-'));
  try {
    await writeFile(join(repo, 'keep.txt'), 'fica\n');
    await writeFile(join(repo, 'gone.txt'), 'some depois\n');
    await exec('git', ['init', '-q'], {cwd: repo, env: GIT_ENV});
    await exec('git', ['add', '.'], {cwd: repo, env: GIT_ENV});
    await exec('git', ['commit', '-q', '-m', 'um'], {cwd: repo, env: GIT_ENV});
    const admitted = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo})).stdout.trim();
    await exec('git', ['rm', '-q', 'gone.txt'], {cwd: repo, env: GIT_ENV});
    await exec('git', ['commit', '-q', '-m', 'apaga gone.txt'], {cwd: repo, env: GIT_ENV});
    assert.match(await deletedHistoryExcerpt(repo), /gone\.txt/);
    assert.equal((await deletedHistoryExcerpt(repo, admitted)).includes('gone.txt'), false);
  } finally {
    await rm(repo, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------- 2. cobertura declarada

test('1 item declarado de todos os pedidos: confirmado 1, pendentes o resto, também depois do reexame', async () => {
  const ready = await bootVerify('integ_coverage');
  try {
    await seed(ready.repo, 3);
    const {worker} = planned({declare: 1, unreadFirst: ['src/m02.ts']});
    const result = await run(ready, worker, {batch: {tokens: 40_000, files: 8}});
    const requested = (await run(ready, planned().worker, {batch: false})).coverage[0]?.requested ?? [];
    assert.ok(requested.length > 1, 'o plano pede mais de um item');
    assert.deepEqual(result.coverage.map(row => row.file), ['src/m00.ts', 'src/m01.ts', 'src/m02.ts']);
    for (const row of result.coverage) {
      assert.equal(row.checklist.length, 1, `${row.file}: só o declarado conta`);
      assert.deepEqual(row.requested, requested);
      assert.equal(row.pending?.length, requested.length - 1, `${row.file}: o resto fica pendente`);
      assert.equal(row.pending?.includes(row.checklist[0] ?? ''), false);
    }
    // m02 não foi julgado no lote, foi reexaminado sozinho e a lacuna continua visível.
    const report = await blob(result.directory);
    assert.match(report, /\| src\/m02\.ts \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \|/);
    const direct = await readFile(join(result.directory, 'cobertura.md'), 'utf8');
    const row = direct.split('\n').find(line => line.startsWith('| src/m02.ts |')) ?? '';
    assert.equal(row.split('|').length, 7);
    assert.notEqual(row.split('|')[5]?.trim(), '');
  } finally { await ready.close(); }
});

test('34 itens pedidos e 1 declarado dão 1 confirmado e 33 pendentes na fatia padrão', async () => {
  const ready = await bootVerify('integ_cov34');
  try {
    await seed(ready.repo, 1);
    const items = Array.from({length: 34}, (_, index) => `ITEM-${String(index + 1).padStart(2, '0')}`);
    const checklist = items.map(id => ({id, source: 'ASVS-5.0' as const, title: id, appliesTo: 'any' as const, prompt: `Verificar ${id}.`}));
    const worker: VerifyWorker = {async run(call) {
      if (call.task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: []});
      return JSON.stringify({kind: 'exame', filesRead: ['src/m00.ts'], checklist: ['ITEM-07'], findings: []});
    }};
    const result = await run(ready, worker, {checklist});
    const row = result.coverage[0];
    assert.deepEqual(row?.checklist, ['ITEM-07']);
    assert.equal(row?.requested?.length, 34);
    assert.equal(row?.pending?.length, 33);
    assert.equal(row?.pending?.includes('ITEM-07'), false);
  } finally { await ready.close(); }
});

// ---------------------------------------------------------------- 3. resultado por ferramenta

async function toolDirectory(files: Record<string, string | undefined>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-verify-tools-'));
  for (const [name, body] of Object.entries(files)) if (body !== undefined) await writeFile(join(dir, name), body);
  return dir;
}

const ALL_CLEAN_CODES = {
  ...Object.fromEntries(['gitleaks', 'osv-scanner', 'syft', 'grype', 'opengrep', 'hadolint', 'trivy-config', 'trivy-fs', 'checkov'].map(name => [`${name}.code`, '0\n'])),
  // Relatórios de uma execução limpa de verdade: arquivo presente, JSON válido, sem achados.
  'gitleaks.json': '[]',
  'osv.json': '{"results":[]}',
  'syft.cdx.json': '{"bomFormat":"CycloneDX"}',
  'grype.json': '{"matches":[]}',
  'opengrep.json': '{"results":[],"errors":[]}',
  'hadolint.json': '[]',
  'trivy-config.json': '{"SchemaVersion":2}',
  'trivy-fs.json': '{"SchemaVersion":2}',
};

test('quatro estados por ferramenta: limpa, achado válido, indisponível e saída truncada', async () => {
  const dir = await toolDirectory({
    ...ALL_CLEAN_CODES,
    'status.json': '{}\n',
    'gitleaks.version': 'v8.99.0\n',
    'hadolint.json': JSON.stringify([{code: 'DL3002', file: 'Dockerfile', line: 2, level: 'error', message: 'Last user should not be root'}]),
    // Ferramenta que sai com erro e relatório vazio: antes virava código 0 e "sem achados".
    'grype.code': '127\n',
    'opengrep.code': '2\n',
    'opengrep.json': '{}',
    // O JSON cortado de osv.json não pode virar "zero achados, concluído".
    'osv-scanner.code': '1\n',
    'osv.json': '{"results":[{"source":{"path":"package.json"},"packages":[{"package":{"name":"pk',
  });
  try {
    const collected = await collectToolFindings(dir);
    const byName = new Map(collected.tools.map(tool => [tool.name, tool]));
    assert.equal(collected.tools.length, 9);
    assert.equal(byName.get('gitleaks')?.state, 'limpa');
    assert.equal(byName.get('gitleaks')?.version, 'v8.99.0');
    assert.equal(byName.get('gitleaks')?.exitCode, 0);
    assert.equal(byName.get('hadolint')?.state, 'achado');
    assert.equal(byName.get('hadolint')?.findings, 1);
    assert.equal(byName.get('grype')?.state, 'indisponivel');
    assert.match(byName.get('grype')?.reason ?? '', /127/);
    assert.equal(byName.get('opengrep')?.state, 'indisponivel');
    assert.match(byName.get('opengrep')?.reason ?? '', /código de saída 2 inesperado/);
    assert.equal(byName.get('osv-scanner')?.state, 'truncada');
    assert.equal(byName.get('osv-scanner')?.formatValid, false);
    assert.equal(byName.get('osv-scanner')?.fileFound, true);
    assert.equal(byName.get('trivy-fs')?.state, 'limpa');
    assert.equal(byName.get('checkov')?.state, 'limpa');
    assert.equal(collected.findings.length, 1);
    assert.equal(collected.findings[0]?.tool, 'hadolint');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('osv-scanner com código 0 e arquivo cortado, ou com código 1 sem achados, não é execução limpa', async () => {
  const cut = await toolDirectory({...ALL_CLEAN_CODES, 'status.json': '{}', 'osv.json': '{"results":['});
  const lying = await toolDirectory({...ALL_CLEAN_CODES, 'status.json': '{}', 'osv-scanner.code': '1\n', 'osv.json': '{"results":[]}'});
  const none = await toolDirectory({...ALL_CLEAN_CODES, 'status.json': '{}', 'osv-scanner.code': '128\n', 'osv.json': undefined});
  try {
    assert.equal((await collectToolFindings(cut)).tools.find(tool => tool.name === 'osv-scanner')?.state, 'truncada');
    const second = (await collectToolFindings(lying)).tools.find(tool => tool.name === 'osv-scanner');
    assert.equal(second?.state, 'truncada');
    assert.match(second?.reason ?? '', /indica achados/);
    // 128 do osv-scanner é "nenhum pacote", sem relatório: limpa, com o motivo dito.
    const third = (await collectToolFindings(none)).tools.find(tool => tool.name === 'osv-scanner');
    assert.equal(third?.state, 'limpa');
    assert.match(third?.reason ?? '', /nada a examinar/);
  } finally {
    for (const dir of [cut, lying, none]) await rm(dir, {recursive: true, force: true});
  }
});

test('o relatório e o resumo mostram ferramenta indisponível e saída truncada em vez de execução limpa', async () => {
  const ready = await bootVerify('integ_tools');
  try {
    await seed(ready.repo, 1);
    const dir = await toolDirectory({...ALL_CLEAN_CODES, 'status.json': '{}', 'grype.code': '127\n', 'osv.json': '{"results":[', 'osv-scanner.code': '0\n'});
    const collected = await collectToolFindings(dir);
    await rm(dir, {recursive: true, force: true});
    const result = await run(ready, planned().worker, {toolResults: collected.tools as ToolResult[]});
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /## Execução das ferramentas/);
    assert.match(readme, /\| grype \|[^\n]*ferramenta indisponível/);
    assert.match(readme, /\| osv-scanner \|[^\n]*saída truncada/);
    assert.match(readme, /\| gitleaks \|[^\n]*execução limpa/);
    const [summary] = await listSecurityReports(ready.dataDirectory, ready.project);
    assert.match(summary?.note ?? '', /Ferramenta grype indisponível/);
    assert.match(summary?.note ?? '', /Ferramenta osv-scanner com saída truncada/);
    assert.equal(summary?.tools?.indisponivel, 1);
    assert.equal(summary?.tools?.truncada, 1);
    assert.equal(summary?.tools?.limpa, 7);
  } finally { await ready.close(); }
});

// ---------------------------------------------------------------- 4. orçamento

test('orçamento esgotado no mapa: relatório parcial com tudo pendente e nada confirmado', async () => {
  const ready = await bootVerify('integ_bud_map');
  try {
    await seed(ready.repo, 3);
    const {worker, tasks} = planned();
    // O contador compartilhado já gastou a única chamada permitida.
    const result = await run(ready, worker, {modelCalls: {count: 1}, modelCallBudget: 1});
    assert.equal(tasks.length, 0);
    assert.equal(result.partial?.phase, 'mapa');
    assert.deepEqual(result.partial?.pendingFiles, ['src/m00.ts', 'src/m01.ts', 'src/m02.ts']);
    assert.equal(result.achados.length, 0);
    assert.equal(result.coverage.length, 0);
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /## Relatório parcial/);
    assert.match(readme, /parou antes do mapa/);
    const [summary] = await listSecurityReports(ready.dataDirectory, ready.project);
    assert.equal(summary?.partial, true);
    assert.match(summary?.note ?? '', /^Relatório parcial/);
  } finally { await ready.close(); }
});

test('orçamento esgotado na primeira de várias fatias: a fatia feita fica, o resto é inventariado e o achado não é promovido', async () => {
  const ready = await bootVerify('integ_bud_slice');
  try {
    await seed(ready.repo, 20);
    const {worker, tasks} = planned({findingIn: slice => ({file: slice[0] ?? 'src/m00.ts', line: 1})});
    // mapa + fatia 1. A fatia 2 e a confirmação ficam sem chamada.
    const result = await run(ready, worker, {modelCallBudget: 2});
    assert.equal(tasks.length, 2);
    assert.equal(result.partial?.phase, 'exame');
    assert.equal(result.partial?.point, 'antes da fatia fatia-2');
    assert.equal(result.coverage.length, 15);
    assert.deepEqual(result.partial?.pendingFiles, Array.from({length: 5}, (_, index) => `src/m${String(index + 15).padStart(2, '0')}.ts`));
    assert.equal(result.achados.length, 1);
    assert.equal(result.achados[0]?.status, 'provavel');
    assert.equal(result.achados[0]?.verifier, null);
    assert.equal(result.partial?.unreviewed.length, 1);
    const report = await blob(result.directory);
    assert.match(report, /Sem revisão independente/);
    assert.match(report, /Achados sem revisão independente: 1/);
    for (let index = 15; index < 20; index += 1) assert.match(report, new RegExp(`- src/m${index}\\.ts`));
    // O que foi concluído está no banco: a execução fecha como feita, não como falha.
    const status = (await ready.db.pool.query('SELECT status FROM ac_verify_runs WHERE id=$1', [result.runId])).rows[0]?.status;
    assert.equal(status, 'done');
  } finally { await ready.close(); }
});

test('orçamento esgotado na confirmação final (20 arquivos, 2 fatias, orçamento 3): achados ficam sem revisão', async () => {
  const ready = await bootVerify('integ_bud_conf');
  try {
    await seed(ready.repo, 20);
    const confirmed: string[] = [];
    const {worker, tasks} = planned({findingIn: slice => ({file: slice[0] ?? 'src/m00.ts', line: 1}), onConfirm: task => { confirmed.push(task); }});
    const result = await run(ready, worker, {modelCallBudget: 3});
    assert.equal(tasks.length, 3);
    assert.equal(confirmed.length, 0);
    assert.equal(result.partial?.phase, 'confirmacao');
    assert.equal(result.coverage.length, 20);
    assert.deepEqual(result.partial?.pendingFiles, []);
    assert.equal(result.achados.length, 2);
    assert.ok(result.achados.every(item => item.status === 'provavel' && item.verifier === null));
    assert.equal(result.partial?.unreviewed.length, 2);
    // Com uma chamada a mais, a primeira confirmação roda e só a segunda fica sem revisão.
    const more = await run(ready, planned({findingIn: slice => ({file: slice[0] ?? 'src/m00.ts', line: 1})}).worker, {modelCallBudget: 4});
    assert.deepEqual(more.achados.map(item => item.status), ['confirmado', 'provavel']);
    assert.equal(more.partial?.unreviewed.length, 1);
  } finally { await ready.close(); }
});

test('o reexame de arquivo só gasta o que as confirmações devidas não vão precisar', async () => {
  const ready = await bootVerify('integ_bud_retry');
  try {
    await seed(ready.repo, 3);
    // mapa + lote + achado devido: o reexame de m02 custaria a chamada da confirmação.
    const {worker, tasks} = planned({unreadFirst: ['src/m02.ts'], findingIn: slice => ({file: slice[0] ?? 'src/m00.ts', line: 1})});
    const result = await run(ready, worker, {batch: {tokens: 40_000, files: 8}, modelCallBudget: 3});
    assert.equal(tasks.filter(task => task.startsWith('Pedido de exame.')).length, 1);
    assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 1);
    assert.equal(result.partial, undefined);
    assert.equal(result.achados[0]?.status, 'confirmado');
    assert.match(await blob(result.directory), /Arquivo pendente, sem julgamento do examinador: src\/m02\.ts/);
  } finally { await ready.close(); }
});

// ---------------------------------------------------------------- 5. painel e CLI

test('o painel e a CLI montam as opções do exame pela mesma função', async () => {
  const defaults = examRunOptions(undefined);
  assert.deepEqual(defaults, {mapEnabled: true, batch: {tokens: 40_000, files: 8}, pollBackoff: true, productionOnly: true});
  assert.deepEqual(examRunOptions({map: false, batch: false, managerDiscipline: false, securityProductionOnly: false}),
    {mapEnabled: false, batch: false, pollBackoff: false, productionOnly: false});
  assert.deepEqual(examRunOptions({batchTokens: 12_000, batchFiles: 3}).batch, {tokens: 12_000, files: 3});
  // As duas entradas chamam a função e nenhuma monta batch ou mapa à mão.
  const panel = await readFile('src/server-main.ts', 'utf8');
  const cli = await readFile('src/verify-command.ts', 'utf8');
  assert.match(panel, /examRunOptions\(project\.economy\)/);
  assert.match(panel, /mapEnabled:examOptions\.mapEnabled,batch:examOptions\.batch/);
  assert.match(cli, /examRunOptions\(project\.economy\)\.mapEnabled/);
  assert.equal(/batchTokens/.test(panel), false);
  assert.equal(/economy\?\.batch === false/.test(cli.replace(/export function examRunOptions[\s\S]*?\n}\n/, '')), false);
});

test('mesmo projeto e inventário: mesmas fatias e tarefas; batch:false é uma chamada por arquivo nas duas entradas', async () => {
  const ready = await bootVerify('integ_panelcli');
  try {
    await seed(ready.repo, 6);
    const economy = {map: true, batch: false as const};
    const fromPanel = planned();
    const fromCli = planned();
    const options = examRunOptions(economy);
    const one = await run(ready, fromPanel.worker, {mapEnabled: options.mapEnabled, batch: options.batch});
    const two = await run(ready, fromCli.worker, {mapEnabled: examRunOptions(economy).mapEnabled, batch: examRunOptions(economy).batch});
    const exams = (tasks: string[]) => tasks.filter(task => task.startsWith('Pedido de exame.'));
    assert.equal(exams(fromPanel.tasks).length, 6);
    assert.equal(exams(fromCli.tasks).length, 6);
    const strip = (task: string) => task.replace(/^Fatia: .*$/m, '');
    assert.deepEqual(exams(fromPanel.tasks).map(strip), exams(fromCli.tasks).map(strip));
    assert.deepEqual(one.coverage.map(row => row.file), two.coverage.map(row => row.file));
    // O padrão do projeto (sem a opção) agrupa: o plano é o mesmo que a CLI calcula.
    const grouped = examRunOptions({});
    const files = Array.from({length: 20}, (_, index) => `src/m${String(index).padStart(2, '0')}.ts`);
    const tokens = new Map(files.map(file => [file, 100]));
    const checklist = loadSecurityChecklist();
    assert.deepEqual(planSecuritySlices(files, checklist, tokens, grouped.batch).map(slice => slice.files.length), [15, 5]);
  } finally { await ready.close(); }
});
