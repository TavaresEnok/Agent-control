import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {nativeReviewMapScope, nativeTaskWithRepoMap} from '../src/native-repo-map.ts';

test('native programmer and reviewer prompts include the map for their respective scopes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-native-repo-map-'));
  try {
    const repoPath = join(directory, 'checkout');
    await mkdir(join(repoPath, 'src'), {recursive: true});
    const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], {encoding: 'utf8'}).trim();
    const save = (path: string, contents: string) => writeFile(join(repoPath, path), contents);
    git('init', '--quiet');
    git('config', 'user.name', 'Native Map Test');
    git('config', 'user.email', 'fixture@example.invalid');
    await save('src/module.ts', 'export function before() {}\n');
    await save('outside.ts', 'export function outside() {}\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    await save('src/module.ts', 'export function after() {}\n');
    await save('src/another.ts', 'export function another() {}\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'artifact');
    const commit = git('rev-parse', 'HEAD');

    const task = JSON.stringify({instruction: 'Implementar o pedido.', request: 'Alterar src.'});
    const env = {jobId: 'fixture', repoPath, projectId: 'fixture', dataDirectory: join(directory, 'data'), secrets: []};
    git('checkout', '--quiet', '--detach', base);
    const programmer = JSON.parse(await nativeTaskWithRepoMap({
      ...env, task, commit: base, scope: async () => ['src'],
    }));
    assert.equal(programmer.request, 'Alterar src.');
    assert.equal(programmer.instruction, 'Implementar o pedido.');
    assert.match(programmer.repoMap.instruction, /use o mapa antes de abrir arquivos/i);
    assert.match(programmer.repoMap.map, /function before/);
    assert.doesNotMatch(programmer.repoMap.map, /function (after|outside)/);

    git('checkout', '--quiet', '--detach', commit);
    const scope = await nativeReviewMapScope(repoPath, base, commit);
    assert.deepEqual(scope, ['src/another.ts', 'src/module.ts']);
    const reviewer = JSON.parse(await nativeTaskWithRepoMap({
      ...env, task: '{"kind":"review"}', commit, scope: async () => scope,
    }));
    assert.equal(reviewer.kind, 'review');
    assert.match(reviewer.repoMap.map, /function after/);
    assert.match(reviewer.repoMap.map, /function another/);
    assert.doesNotMatch(reviewer.repoMap.map, /function (before|outside)/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('optional native map failures retain the original task and report bounded reasons', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {});
  const task = '{"request":"original"}';
  const input = {task, jobId: 'fixture', repoPath: '/unused', commit: 'a'.repeat(40), projectId: 'fixture',
    dataDirectory: '/unused', secrets: ['secret-fixture'], scope: async () => ['src']};
  const unavailable = await nativeTaskWithRepoMap(input, async () => {
    throw new Error('private path and provider detail');
  });
  assert.equal(unavailable, task);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0]?.arguments[0])), {
    event: 'NATIVE_REPO_MAP_SKIPPED', jobId: 'fixture', reason: 'REPO_MAP_GENERATION_FAILED',
  });
  const result = (map: string) => ({
    commit: input.commit, map, estimatedTokens: 10, budgetTokens: 4000,
    totalCandidateFiles: 1, includedFiles: 1, omittedFiles: 0, fromCache: false,
  });
  const unusedGenerator = t.mock.fn(async () => result('unused'));
  assert.equal(await nativeTaskWithRepoMap({...input, scope: async () => []}, unusedGenerator), task);
  assert.equal(unusedGenerator.mock.callCount(), 0);
  assert.equal(await nativeTaskWithRepoMap(input, async () => ({
    ...result('Mapa sem arquivos.'), includedFiles: 0, omittedFiles: 1,
  })), task);
  assert.equal(await nativeTaskWithRepoMap(input, async () => result('function secret-fixture')), task);
  assert.equal(await nativeTaskWithRepoMap(input, async () => result('x'.repeat(100_000))), task);
  assert.deepEqual(warning.mock.calls.slice(1).map(call => JSON.parse(String(call.arguments[0])).reason), [
    'REPO_MAP_SCOPE_EMPTY', 'REPO_MAP_NO_FILES_INCLUDED', 'NATIVE_EXECUTION_SECRET_IN_TASK', 'REPO_MAP_TASK_LIMIT',
  ]);
});
