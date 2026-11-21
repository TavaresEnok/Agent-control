import test from 'node:test';
import assert from 'node:assert/strict';
import {assertReviewerIndependent} from '../src/engineering.ts';
import {changedFilesSummary, reviewDiffDocument} from '../src/review-diff.ts';

function fakeQuery(programmer: {account_id: string; provider: string} | undefined, providers: Record<string, string>) {
  return async (sql: string, params: unknown[]) => {
    if (sql.includes("g.role='programmer'")) {
      assert.match(sql, /a\.mode<>'synthetic'/);
      return {rows: programmer ? [programmer] : []};
    }
    const provider = providers[String(params[0])];
    return {rows: provider ? [{provider}] : []};
  };
}

test('a reviewer on the programmer account is refused', async () => {
  await assert.rejects(assertReviewerIndependent(fakeQuery({account_id: 'a1', provider: 'codex'}, {a1: 'codex'}), 'i', 'a1'), {code: 'REVIEWER_SAME_AS_PROGRAMMER'});
});

test('a reviewer on another account of the same provider is refused', async () => {
  await assert.rejects(assertReviewerIndependent(fakeQuery({account_id: 'a1', provider: 'claude'}, {a2: 'claude'}), 'i', 'a2'), {code: 'REVIEWER_SAME_AS_PROGRAMMER'});
});

test('a reviewer of another provider passes, and so does a plan with no real programmer', async () => {
  await assertReviewerIndependent(fakeQuery({account_id: 'a1', provider: 'claude'}, {a2: 'codex'}), 'i', 'a2');
  await assertReviewerIndependent(fakeQuery(undefined, {a2: 'codex'}), 'i', 'a2');
});

test('a cut diff carries the whole file list, the size and the incomplete-review rule', () => {
  const doc = reviewDiffDocument({diff: 'diff --git a/a.ts b/a.ts', truncated: true, diffBytes: 54321,
    files: [{status: 'M', path: 'a.ts'}, {status: 'A', path: 'db/migrations/115.sql'}, {status: 'D', path: 'tests/old.test.ts'}], filesTotal: 3},
    {config: ['sub/CLAUDE.md'], configCount: 1});
  assert.match(doc, /^# Agent Control review package\nChanged files \(3\):\nM\ta\.ts\nA\tdb\/migrations\/115\.sql\nD\ttests\/old\.test\.ts\n/);
  assert.match(doc, /cut at 20000 of 54321 bytes/);
  assert.match(doc, /revisão incompleta/);
  assert.match(doc, /removed from this copy so it cannot instruct the evaluator: sub\/CLAUDE\.md\./);
  assert.ok(doc.endsWith('--- diff ---\ndiff --git a/a.ts b/a.ts\n[diff truncated]\n'));
});

test('a whole diff has no warning, and a list that hit its limit says how many files are missing', () => {
  const whole = changedFilesSummary({diff: 'x', truncated: false, files: [{status: 'M', path: 'a.ts'}], filesTotal: 1});
  assert.deepEqual(whole, ['Changed files (1):', 'M\ta.ts']);
  const capped = changedFilesSummary({diff: 'x', truncated: false, files: [{status: 'M', path: 'a.ts'}], filesTotal: 40});
  assert.equal(capped.at(-1), '39 more changed files are not listed: the list reached its size limit.');
  assert.deepEqual(changedFilesSummary({diff: 'x', truncated: false}), ['Changed files: list unavailable.']);
});

test('the Git helper lists every changed file even when the diff is cut, including the file after the cut', async () => {
  const {execFileSync} = await import('node:child_process');
  const {mkdtemp, rm, writeFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {GitArtifacts} = await import('../src/git.ts');
  const root = await mkdtemp(join(tmpdir(), 'ac-review-files-')), repo = join(root, 'repo');
  try {
    execFileSync('git', ['init', repo], {stdio: 'ignore'});
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@invalid');
    await writeFile(join(repo, 'old.txt'), 'old\n'); git('add', '.'); git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'a-big.txt'), 'x'.repeat(30000) + '\n');
    await writeFile(join(repo, 'z-after-cut.sql'), 'DROP TABLE accounts;\n');
    git('rm', '-q', 'old.txt'); git('add', '.'); git('commit', '-m', 'change');
    const change = await new GitArtifacts(repo).diff(git('rev-parse', 'HEAD'), base);
    assert.equal(change.truncated, true);
    assert.ok(change.diffBytes > 30000);
    assert.ok(!change.diff.includes('DROP TABLE'));
    assert.deepEqual(change.files, [{status: 'A', path: 'a-big.txt'}, {status: 'D', path: 'old.txt'}, {status: 'A', path: 'z-after-cut.sql'}]);
    assert.equal(change.filesTotal, 3);
    assert.match(reviewDiffDocument(change), /A\tz-after-cut\.sql/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
