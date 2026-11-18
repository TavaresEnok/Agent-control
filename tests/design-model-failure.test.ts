import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {DesignCreateModelFailure, runDesignCreate} from '../src/design-create.ts';
import {runDesignModule} from '../src/design-module.ts';
import {designCliFailureText, designExamStatus} from '../src/personal-design-cli.ts';
import {EXAM_LOGIN_STALE_TEXT} from '../src/exam-login.ts';

const SECRET = 'sk-SUPERSECRETTOKENVALUE';
const AUTH = `Failed to authenticate: OAuth session expired ${SECRET}`;
const VISUAL_LINE = 'A crítica visual foi pedida e nenhuma tela foi julgada.';

function seat() {
  return {provider: 'claude', model: 'modelo', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
}

test('falha de autenticação do modelo não deixa o exame visual como ok', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-fail-'));
  const repo = await mkdtemp(join(tmpdir(), 'design-fail-repo-'));
  try {
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T12:00:00.000Z'),
      commit: 'abc123',
      files: [{path: 'index.html', text: '<html><body><h1>Oi</h1></body></html>'}],
      scoreVisual: true,
      worker: {async run() { return AUTH; }},
      reserve: async () => seat(),
      release: async () => {},
    });
    assert.equal(result.visualUnjudged, true);
    assert.equal(result.loginStale, false);
    const coverage = await readFile(join(result.directory, 'cobertura.md'), 'utf8');
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(coverage, /\| examinador \| modelo \| 1 \| 0 \| PROVIDER_AUTH_FAILED \|/);
    assert.match(coverage, /\| revisor \| modelo \| 1 \| 0 \| PROVIDER_AUTH_FAILED \|/);
    assert.match(readme, /Cobertura do exame/);
    assert.match(readme, /\| examinador \| modelo \| 1 \| 0 \| PROVIDER_AUTH_FAILED \|/);
    assert.equal(coverage.includes(SECRET), false);
    assert.equal(readme.includes(SECRET), false);
    assert.equal(coverage.includes('Failed to authenticate'), false);
    assert.equal(readme.includes('Failed to authenticate'), false);
    assert.deepEqual(designExamStatus(result), {code: 1, lines: [VISUAL_LINE]});
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
});

test('resposta vazia ou de autenticação na criação não vira pedido inválido', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-create-fail-'));
  const repo = await mkdtemp(join(tmpdir(), 'design-create-repo-'));
  const base = {
    dataDirectory: data,
    repository: repo,
    briefing: 'Uma tela.',
    screens: 1,
    rounds: 1,
    referenceNote: '',
    reserve: async () => seat(),
    release: async () => {},
    intentId: randomUUID(),
    examine: async () => {
      throw new Error('examine-called');
    },
  };
  try {
    await assert.rejects(
      () => runDesignCreate({...base, runId: randomUUID(), worker: {async run() { return '   '; }}}),
      (error: unknown) => error instanceof DesignCreateModelFailure && error.code === 'DESIGN_CREATE_MODEL_FAILED' && error.causeCode === 'EXECUTION_NATIVE_FAILED',
    );
    await assert.rejects(
      () => runDesignCreate({...base, runId: randomUUID(), worker: {async run() { return AUTH; }}}),
      (error: unknown) => error instanceof DesignCreateModelFailure && error.causeCode === 'PROVIDER_AUTH_FAILED',
    );
    await assert.rejects(
      () => runDesignCreate({...base, runId: randomUUID(), worker: {async run() { return JSON.stringify({kind: 'nao-e-bundle'}); }}}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_INVALID',
    );
    const authFailure = new DesignCreateModelFailure('PROVIDER_AUTH_FAILED');
    const text = designCliFailureText(authFailure);
    assert.match(text, /Causa: PROVIDER_AUTH_FAILED/);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes('Failed to authenticate'), false);
    assert.deepEqual(designExamStatus({visualUnjudged: true}), {code: 1, lines: [VISUAL_LINE]});
    assert.deepEqual(designExamStatus({loginStale: true, visualUnjudged: true}), {code: 1, lines: [EXAM_LOGIN_STALE_TEXT, VISUAL_LINE]});
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
});
