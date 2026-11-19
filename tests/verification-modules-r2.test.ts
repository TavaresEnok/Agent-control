import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {
  parseModuleCollectorOutput,
  prepareModuleSnapshot,
  removeModuleSnapshot,
  runBoundedCollectorProcess,
} from '../src/verification-modules.ts';

test('cobertura preserva arquivos medidos e aceita caminhos legítimos com ponto', () => {
  const coverage = [
    {tool: 'scanner', version: '2', status: 'ok', detail: 'medido', files: ['package.json', '.github/workflows/ci.yml']},
    {tool: 'other', version: '1', status: 'skipped', detail: 'não executado', files: []},
  ];
  const findings = [{tool: 'scanner', rule: 'r1', file: '.github/workflows/ci.yml', line: 1, severity: 'baixa', message: 'm', evidence: 'e'}];
  assert.deepEqual(parseModuleCollectorOutput(JSON.stringify({coverage, findings})), {coverage, findings});
  for (const file of ['../segredo', '.git/config', 'src/.env.local']) {
    assert.throws(() => parseModuleCollectorOutput(JSON.stringify({coverage: [{...coverage[0], files: [file]}], findings: []})),
      (error: unknown) => error instanceof Refusal);
  }
});

test('snapshot conserva conteúdo do commit dentro de pai privado e remove o pai', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-r2-test-'));
  let snapshot: string | undefined;
  try {
    const repo = join(root, 'repo');
    await mkdir(repo, {mode: 0o700});
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    git('init');
    git('config', 'user.name', 'Synthetic');
    git('config', 'user.email', 'synthetic@example.invalid');
    await writeFile(join(repo, 'file.txt'), 'commit\n');
    git('add', 'file.txt');
    git('commit', '-m', 'synthetic');
    const commit = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'file.txt'), 'alterado\n');
    snapshot = await prepareModuleSnapshot(repo, commit);
    const parent = dirname(snapshot);
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(snapshot, 'file.txt'), 'utf8'), 'commit\n');
    await removeModuleSnapshot(snapshot);
    snapshot = undefined;
    await assert.rejects(stat(parent), {code: 'ENOENT'});
  } finally {
    if (snapshot) await removeModuleSnapshot(snapshot);
    await rm(root, {recursive: true, force: true});
  }
});

test('cancelamento interrompe processo de coleta sem Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-r2-abort-'));
  try {
    const marker = join(root, 'marker');
    const controller = new AbortController();
    const task = runBoundedCollectorProcess(
      [process.execPath, '-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'executou'), 600)", marker],
      {timeoutMs: 3000, maxStdoutBytes: 1024, signal: controller.signal},
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(task, (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_TOOLS_FAILED');
    await new Promise(resolve => setTimeout(resolve, 700));
    await assert.rejects(stat(marker), {code: 'ENOENT'});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
