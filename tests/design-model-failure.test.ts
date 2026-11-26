// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {designBenchWorker} from '../src/design-bench.ts';
import {DesignCreateModelFailure, runDesignCreate} from '../src/design-create.ts';
import {runDesignModule} from '../src/design-module.ts';
import {designCliFailureText, designExamStatus} from '../src/personal-design-cli.ts';
import {EXAM_LOGIN_STALE_TEXT} from '../src/exam-login.ts';
import {UnstartedExamRetirementPending} from '../src/native-execution-supervisor.ts';

const SECRET = 'sk-SUPERSECRETTOKENVALUE';
const AUTH = `Failed to authenticate: OAuth session expired ${SECRET}`;
const VISUAL_LINE = 'A crítica visual foi pedida e nenhuma tela foi julgada.';

test('pendência da retirada chega ao consumidor do exame com o job para retry', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-pending-'));
  const repo = await mkdtemp(join(tmpdir(), 'design-pending-repo-'));
  const pending = new UnstartedExamRetirementPending(randomUUID());
  try {
    await assert.rejects(runDesignModule({
      activation:'personal', projectId:randomUUID(), repo, targetUrl:'http://127.0.0.1:4173', dataDirectory:data,
      intentId:randomUUID(), runId:randomUUID(), createdAt:new Date(), commit:'abc123',
      files:[{path:'index.html',text:'<html><body><h1>Oi</h1></body></html>'}], scoreVisual:true,
      worker:{async run(){throw pending;}}, reserve:async()=>seat(), release:async()=>{},
    }), error=>error===pending && designCliFailureText(error).includes(`--abandonar-design ${pending.jobId}`));
  } finally {
    await rm(data,{recursive:true,force:true});
    await rm(repo,{recursive:true,force:true});
  }
});

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

test('crítica visual com uma tela julgada e outra incompleta grava relatório e sai com erro', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-visual-partial-'));
  const repo = await mkdtemp(join(tmpdir(), 'design-visual-partial-repo-'));
  const bench = designBenchWorker();
  try {
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T12:10:00.000Z'),
      commit: 'abc123',
      files: [
        {path: 'a.html', text: '<html><body><h1>Tela A</h1></body></html>'},
        {path: 'b.html', text: '<html><body><h1>Tela B</h1></body></html>'},
      ],
      routes: [{route: '/a.html'}, {route: '/b.html'}],
      scoreVisual: true,
      worker: {
        async run(call) {
          if (call.task.includes('- b.html') && call.task.startsWith('Pedido de crítica visual do revisor.')) {
            return JSON.stringify({kind: 'visual', scores: [{axis: 'hierarquia', score: 8, region: 'topo', suggestion: 'ok'}]});
          }
          return bench.run(call);
        },
      },
      reserve: async role => ({provider: 'claude', model: role, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()}),
      release: async () => {},
    });
    assert.equal(result.visualUnjudged, true);
    assert.equal(result.visualRequested, 2);
    assert.equal(result.visualJudged, 1);
    assert.deepEqual(result.visualMissing, ['/b.html (b.html)']);
    const coverage = await readFile(join(result.directory, 'cobertura.md'), 'utf8');
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(coverage, /\| examinador \| specialist \| 2 \| 2 \| nenhuma \|/);
    assert.match(coverage, /\| revisor \| reviewer \| 2 \| 1 \| nenhuma \|/);
    assert.match(readme, /### \/a\.html/);
    assert.match(readme, /Telas sem crítica visual completa:/);
    assert.match(readme, /- \/b\.html \(b\.html\)/);
    assert.equal(readme.includes('- /a.html (a.html)'), false);
    const status = designExamStatus(result);
    assert.equal(status.code, 1);
    assert.match(status.lines[0] ?? '', /b\.html/);

    // Também com JSON inválido do examinador e falha do provedor em uma segunda tela.
    const invalidJsonResult = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T12:15:00.000Z'),
      commit: 'abc123',
      files: [
        {path: 'a.html', text: '<html><body><h1>Tela A</h1></body></html>'},
        {path: 'c.html', text: '<html><body><h1>Tela C</h1></body></html>'},
      ],
      routes: [{route: '/a.html'}, {route: '/c.html'}],
      scoreVisual: true,
      worker: {
        async run(call) {
          if (call.task.includes('- c.html') && call.task.startsWith('Pedido de exame.')) {
            return 'nao e json';
          }
          if (call.task.includes('- c.html') && call.task.startsWith('Pedido de crítica visual.')) {
            return '{json quebrado';
          }
          if (call.task.includes('- c.html') && call.task.startsWith('Pedido de crítica visual do revisor.')) {
            throw new Refusal('PROVIDER_RATE_LIMIT');
          }
          return bench.run(call);
        },
      },
      reserve: async role => ({provider: 'claude', model: role, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()}),
      release: async () => {},
    });
    assert.equal(invalidJsonResult.visualUnjudged, true);
    assert.deepEqual(invalidJsonResult.visualMissing, ['/c.html (c.html)']);
    const invalidReadme = await readFile(join(invalidJsonResult.directory, 'README.md'), 'utf8');
    assert.match(invalidReadme, /- \/c\.html \(c\.html\)/);
    assert.equal(designExamStatus(invalidJsonResult).code, 1);
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
});

test('crítica visual pedida com zero telas sai com erro e nota clara', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-visual-zero-'));
  const repo = await mkdtemp(join(tmpdir(), 'design-visual-zero-repo-'));
  const bench = designBenchWorker();
  try {
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T12:20:00.000Z'),
      commit: 'abc123',
      files: [],
      scoreVisual: true,
      worker: {async run(call) { return bench.run(call); }},
      reserve: async () => seat(),
      release: async () => {},
    });
    assert.equal(result.visualUnjudged, true);
    assert.equal(result.visualRequested, 0);
    assert.equal(result.visualJudged, 0);
    assert.deepEqual(result.visualMissing, []);
    const coverage = await readFile(join(result.directory, 'cobertura.md'), 'utf8');
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(coverage, /\| examinador \| desconhecido \| 0 \| 0 \| nenhuma \|/);
    assert.match(coverage, /\| revisor \| desconhecido \| 0 \| 0 \| nenhuma \|/);
    assert.match(readme, /A crítica visual foi pedida, mas nenhuma tela entrou no exame\./);
    assert.deepEqual(designExamStatus(result), {
      code: 1,
      lines: ['A crítica visual foi pedida, mas nenhuma tela entrou no exame.'],
    });
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
});
