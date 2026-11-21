import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractGitArchive, stripScannerSuppressions, suppressionNote} from '../src/git-archive-snapshot.ts';

test('a refs/replace entry in the examined repository cannot swap the archived content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-archive-replace-')), repo = join(root, 'repo');
  try {
    execFileSync('git', ['init', repo], {stdio: 'ignore'});
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@invalid');
    await writeFile(join(repo, 'app.js'), 'eval(userInput);\n'); git('add', '.'); git('commit', '-m', 'real');
    const real = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'app.js'), 'console.log("clean");\n'); git('add', '.'); git('commit', '-m', 'decoy');
    const decoy = git('rev-parse', 'HEAD');
    git('replace', real, decoy);
    // Canary: plain git archive follows the replacement and would examine the decoy.
    const plain = join(root, 'plain'); await mkdir(plain);
    execFileSync('sh', ['-c', `git -C "${repo}" archive --format=tar ${real} | tar -x -C "${plain}"`]);
    assert.equal(await readFile(join(plain, 'app.js'), 'utf8'), 'console.log("clean");\n');
    const out = join(root, 'out'); await mkdir(out);
    await extractGitArchive(repo, real, out);
    assert.equal(await readFile(join(out, 'app.js'), 'utf8'), 'eval(userInput);\n');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('an unknown commit is VERIFY_COMMIT_INVALID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-archive-bad-')), repo = join(root, 'repo');
  try {
    execFileSync('git', ['init', repo], {stdio: 'ignore'});
    const out = join(root, 'out'); await mkdir(out);
    await assert.rejects(extractGitArchive(repo, 'f'.repeat(40), out), {code: 'VERIFY_COMMIT_INVALID'});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('suppression files are removed at any depth and named in the report note', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-suppressions-'));
  try {
    await mkdir(join(root, 'svc', 'api'), {recursive: true});
    for (const path of ['.gitleaksignore', '.gitleaks.toml', 'svc/.semgrepignore', 'svc/api/osv-scanner.toml', 'svc/.trivyignore', 'svc/api/.checkov.yaml'])
      await writeFile(join(root, path), 'x\n');
    await writeFile(join(root, 'svc', 'api', 'main.go'), 'package main\n');
    await writeFile(join(root, 'gitleaks.md'), 'not a suppression\n');
    const removed = await stripScannerSuppressions(root);
    assert.deepEqual(removed, ['.gitleaks.toml', '.gitleaksignore', 'svc/.semgrepignore', 'svc/.trivyignore', 'svc/api/.checkov.yaml', 'svc/api/osv-scanner.toml']);
    assert.deepEqual((await readdir(join(root, 'svc', 'api'))).sort(), ['main.go']);
    assert.equal(await readFile(join(root, 'gitleaks.md'), 'utf8'), 'not a suppression\n');
    assert.match(suppressionNote(removed)!, /^Arquivos de supressão do próprio projeto foram ignorados no exame \(6\): \.gitleaks\.toml, /);
    assert.equal(suppressionNote([]), undefined);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('the entrypoint turns off inline markers and the target config of every scanner that reads one', async () => {
  const entrypoint = await readFile(new URL('../deploy/verify-entrypoint.sh', import.meta.url), 'utf8');
  assert.equal(entrypoint.match(/--ignore-gitleaks-allow --gitleaks-ignore-path \/dev\/null/g)?.length, 2);
  assert.match(entrypoint, /--config \/opt\/agent-control\/rules --disable-nosem \/repository/);
  assert.match(entrypoint, /--no-resolve --config \/tmp\/osv-empty\.toml/);
  assert.equal(entrypoint.match(/--ignorefile '' --config ''/g)?.length, 2);
});
