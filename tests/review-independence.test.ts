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
    {config: ['sub/CLAUDE.md'], configCount: 1, count: 1, paths: ['docs/link']});
  assert.match(doc, /^# Agent Control review package\nChanged files \(3\):\nM\ta\.ts\nA\tdb\/migrations\/115\.sql\nD\ttests\/old\.test\.ts\n/);
  assert.match(doc, /cut at 20000 of 54321 bytes/);
  assert.match(doc, /revisão incompleta/);
  assert.match(doc, /removed from this copy so it cannot instruct the evaluator: sub\/CLAUDE\.md\./);
  assert.match(doc, /Symbolic links were removed from this copy \(1\): docs\/link\./);
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

test('new review jobs get the triage wording; the replay check still accepts jobs launched with the old one', async () => {
  const {nativeReviewRequest, REVIEW_TRIAGE_TEXT} = await import('../src/native-verification.ts');
  const {digest} = await import('../src/contracts.ts');
  const {randomUUID} = await import('node:crypto');
  const artifact = {id: randomUUID(), policy_revision: 1, commit_id: 'a'.repeat(40), tree_id: 'b'.repeat(40), base_id: 'c'.repeat(40)} as any;
  const stage = {id: randomUUID(), session_id: randomUUID()};
  const old = nativeReviewRequest(stage, randomUUID(), randomUUID(), artifact, 'review', 'faça X');
  const fresh = nativeReviewRequest(stage, old.intentId, old.grantId, artifact, 'review', 'faça X', undefined, true);
  assert.ok(!old.task.includes(REVIEW_TRIAGE_TEXT.trim()));
  assert.ok(fresh.task.includes(REVIEW_TRIAGE_TEXT.trim()));
  assert.notEqual(digest(old), digest(fresh));
  const {readFile} = await import('node:fs/promises');
  const source = await readFile(new URL('../src/native-verification.ts', import.meta.url), 'utf8');
  assert.match(source, /replayed\(\),replayed\(asked\),replayed\(asked,scope\),replayed\(undefined,undefined,true\),replayed\(asked,undefined,true\),replayed\(asked,scope,true\)/);
  assert.match(source, /const request=previous\?await supervisor\.storedRequest\(/);
});

test('new programmer jobs get the habits and, in a correction, the recorded failure; existing jobs replay their stored request', async () => {
  const {PROGRAMMER_HABITS_TEXT} = await import('../src/native-implementation.ts');
  assert.match(PROGRAMMER_HABITS_TEXT, /fail before the fix and pass after it/);
  // The reuse ladder travels with the habits into every new programmer request.
  assert.match(PROGRAMMER_HABITS_TEXT, /does this repository already have it/);
  assert.match(PROGRAMMER_HABITS_TEXT, /a dependency already installed;/);
  assert.match(PROGRAMMER_HABITS_TEXT, /Add a new dependency only when none of these solves it, and say why/);
  assert.doesNotMatch(PROGRAMMER_HABITS_TEXT, /never a new one/);
  assert.match(PROGRAMMER_HABITS_TEXT, /Never remove input validation, error handling, security controls, accessibility, tests/);
  const {readFile} = await import('node:fs/promises');
  const source = await readFile(new URL('../src/native-implementation.ts', import.meta.url), 'utf8');
  assert.match(source, /const task=existing\?\(await supervisor\.storedRequest\(owner,authority,intent\.operation_id\)\)\.task:fresh;/);
  assert.match(source, /\.\.\.\(failure\?\{previousFailure:failure\}:\{\}\)/);
  assert.match(source, /if\(!existing&&correction\)/);
});
