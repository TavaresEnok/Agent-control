import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demuxDockerLogs, qaEvidenceLogLine, qaGitIssues, qaLogIssues} from '../src/qa-evidence.ts';
import {GitArtifacts} from '../src/git.ts';
import {QualityPolicy} from '../src/quality-policy.ts';

const frame = (stream: 1 | 2, text: string) => {
  const payload = Buffer.from(text), header = Buffer.alloc(8);
  header[0] = stream; header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};
const codes = (text: string) => qaLogIssues(text).map(issue => issue.code);

test('docker frames are joined, stdout and stderr in order', () => {
  assert.equal(demuxDockerLogs(Buffer.concat([frame(1, 'a\n'), frame(2, 'b\n'), frame(1, 'c\n')])), 'a\nb\nc\n');
  assert.equal(demuxDockerLogs(Buffer.from('plain text')), 'plain text');
});

test('a real pass says nothing', () => {
  assert.deepEqual(codes('# tests 4\n# pass 3\n# fail 0\n# skipped 1\n# todo 0\n'), []);
  assert.deepEqual(codes('ℹ tests 2\nℹ pass 2\nℹ fail 0\n'), []);
  assert.deepEqual(codes('Tests:       12 passed, 12 total\n'), []);
  assert.deepEqual(codes('  7 passing (40ms)\n'), []);
  assert.deepEqual(codes('==== 5 passed, 1 skipped in 0.31s ====\n'), []);
  assert.deepEqual(codes('ok  \texample.com/x\t0.01s\n?   \texample.com/y\t[no test files]\n'), []);
});

test('zero tests, all skipped and failure text under exit 0 are caught', () => {
  assert.deepEqual(codes('# tests 0\n# pass 0\n# fail 0\n'), ['QA_ZERO_TESTS']);
  assert.deepEqual(codes('# tests 3\n# pass 0\n# fail 0\n# skipped 3\n'), ['QA_ALL_SKIPPED']);
  assert.deepEqual(codes('# tests 3\n# pass 2\n# fail 1\n'), ['QA_FAILURE_TEXT']);
  assert.deepEqual(codes('No tests found, exiting with code 0\n'), ['QA_ZERO_TESTS']);
  assert.deepEqual(codes('Tests:       1 failed, 3 passed, 4 total\n'), ['QA_FAILURE_TEXT']);
  assert.deepEqual(codes('  0 passing (1ms)\n'), ['QA_ZERO_TESTS']);
  assert.deepEqual(codes('  3 passing\n  1 failing\n'), ['QA_FAILURE_TEXT']);
  assert.deepEqual(codes('===== 2 skipped in 0.02s =====\n'), ['QA_ALL_SKIPPED']);
  assert.deepEqual(codes('===== 1 failed, 2 passed in 0.10s =====\n'), ['QA_FAILURE_TEXT']);
  assert.deepEqual(codes('collected 0 items\n\n===== no tests ran in 0.01s =====\n'), ['QA_ZERO_TESTS']);
  assert.deepEqual(codes('===== 4 deselected in 0.02s =====\n'), ['QA_ALL_SKIPPED']);
  assert.deepEqual(codes('--- FAIL: TestX (0.00s)\nFAIL\texample.com/x\t0.01s\n'), ['QA_FAILURE_TEXT']);
});

test('git facts become issues and the log line names every code', () => {
  const issues = qaGitIssues({deletedTests: ['tests/a.test.ts'], focused: [{path: 'tests/b.test.ts', line: 3}]});
  assert.deepEqual(issues.map(issue => issue.code), ['QA_FOCUSED_TESTS', 'QA_TEST_FILES_DELETED']);
  assert.match(qaEvidenceLogLine(issues), /^AGENT_CONTROL_QA_EVIDENCE: .*QA_FOCUSED_TESTS \(.*tests\/b\.test\.ts:3\).*QA_TEST_FILES_DELETED \(.*tests\/a\.test\.ts\)/);
  assert.deepEqual(qaGitIssues({deletedTests: [], focused: []}), []);
});

test('the policy accepts qaEvidenceGate and nothing else new', () => {
  const base = {schemaVersion: 1, requiredReviews: 1, allowLowRiskQaWaiver: false, verifierDigest: 'a'.repeat(64)};
  assert.equal(QualityPolicy.parse({...base, qaEvidenceGate: false}).qaEvidenceGate, false);
  assert.equal(QualityPolicy.parse(base).qaEvidenceGate, undefined);
  assert.throws(() => QualityPolicy.parse({...base, qaEvidence: false}));
});

test('the Git helper reports deleted test files and focus markers in test files only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-qa-evidence-')), repo = join(root, 'repo');
  try {
    execFileSync('git', ['init', repo], {stdio: 'ignore'});
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@invalid');
    await mkdir(join(repo, 'tests'));
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'tests', 'old.test.ts'), 'test("x",()=>{});\n');
    await writeFile(join(repo, 'tests', 'kept.test.ts'), 'test("y",()=>{});\n');
    await writeFile(join(repo, 'tests', 'untouched.test.ts'), 'it.only("old focus, not this change",()=>{});\n');
    await writeFile(join(repo, 'tests', 'moved.test.ts'), 'test("moved",()=>{});\n');
    git('add', '.'); git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('rm', '-q', 'tests/old.test.ts');
    await mkdir(join(repo, 'tests', 'unit'));
    git('mv', 'tests/moved.test.ts', 'tests/unit/moved.test.ts');
    await writeFile(join(repo, 'tests', 'kept.test.ts'), 'test("y",()=>{});\ndescribe.only("z",()=>{});\n  fit("w",()=>{});\n');
    await writeFile(join(repo, 'src', 'lint.ts'), 'export const rule = "it.only(";\nit.only("not a test file", () => {});\n');
    git('add', '.'); git('commit', '-m', 'change');
    const facts = await new GitArtifacts(repo).qaEvidence(git('rev-parse', 'HEAD'), base);
    assert.deepEqual(facts.deletedTests, ['tests/old.test.ts']);
    assert.deepEqual(facts.focused, [{path: 'tests/kept.test.ts', line: 2}, {path: 'tests/kept.test.ts', line: 3}]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a downgraded pass is a failed verdict the correction gates accept, with the container code kept', async () => {
  const {readFile} = await import('node:fs/promises');
  const qa = await readFile(new URL('../src/native-qa.ts', import.meta.url), 'utf8');
  assert.ok(qa.includes('exitCode:evidence?1:physical.State.ExitCode'));
  assert.ok(qa.includes('...(evidence?{evidence,containerExitCode:physical.State.ExitCode}:{})'));
  // Both correction gates refuse exitCode<=0; the downgraded receipt carries 1.
  for (const file of ['../src/quality.ts', '../src/engineering.ts'])
    assert.match(await readFile(new URL(file, import.meta.url), 'utf8'), /exitCode<=0/);
});
