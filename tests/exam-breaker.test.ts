import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EXAM_MODEL_CALL_LIMIT, ExamBreaker, ExamStop, isInfrastructureFailure} from '../src/exam-breaker.ts';
import {examPreflight, ExamDependencyDown} from '../src/exam-preflight.ts';

test('três falhas iguais de infraestrutura seguidas abrem o disjuntor', () => {
  const breaker = new ExamBreaker();
  assert.equal(breaker.failure('EXECUTION_TIMEOUT'), false);
  assert.equal(breaker.failure('EXECUTION_TIMEOUT'), false);
  assert.equal(breaker.failure('EXECUTION_TIMEOUT'), true);
  assert.equal(breaker.stopped, 'EXECUTION_TIMEOUT');
  assert.throws(() => breaker.admit(), (error: unknown) => error instanceof ExamStop && error.stopCode === 'EXECUTION_TIMEOUT');
});

test('códigos diferentes recomeçam a contagem e um sucesso a zera', () => {
  const breaker = new ExamBreaker();
  breaker.failure('EXECUTION_TIMEOUT');
  breaker.failure('EXECUTION_TIMEOUT');
  breaker.failure('WORKER_EXITED_WITHOUT_RESULT');
  assert.equal(breaker.streak, 1);
  breaker.failure('WORKER_EXITED_WITHOUT_RESULT');
  breaker.success();
  assert.equal(breaker.streak, 0);
  breaker.failure('WORKER_EXITED_WITHOUT_RESULT');
  breaker.failure('WORKER_EXITED_WITHOUT_RESULT');
  assert.equal(breaker.stopped, null);
  assert.equal(breaker.lastFailureCode, 'WORKER_EXITED_WITHOUT_RESULT');
});

test('falha de conteúdo não conta: o modelo respondeu', () => {
  const breaker = new ExamBreaker();
  for (let at = 0; at < 10; at++) assert.equal(breaker.failure('DESIGN_CONFIRMATION_INVALID'), false);
  for (const code of ['MODULE_EXAM_RESPONSE_INVALID', 'MODULE_CONFIRMATION_INVALID', 'PROVIDER_USAGE_LIMIT', 'EXAM_LOGIN_STALE']) {
    assert.equal(isInfrastructureFailure(code), false, code);
  }
  for (const code of ['EXECUTION_TIMEOUT', 'EXECUTION_NATIVE_FAILED', 'WORKER_EXITED_WITHOUT_RESULT', 'MODULE_EXAM_EGRESS_UNAVAILABLE',
    'NATIVE_IMAGE_MISSING', 'PERSONAL_DISK_FULL', 'PERSONAL_SPACE_BUDGET_EXCEEDED', 'STORAGE_LOW_SPACE']) {
    assert.equal(isInfrastructureFailure(code), true, code);
  }
  assert.equal(breaker.stopped, null);
});

test('disco cheio para na primeira vez', () => {
  for (const code of ['PERSONAL_DISK_FULL', 'PERSONAL_DISK_UNAVAILABLE', 'STORAGE_LOW_SPACE', 'PERSONAL_SPACE_BUDGET_EXCEEDED']) {
    const breaker = new ExamBreaker();
    assert.equal(breaker.failure(code), true, code);
    assert.equal(breaker.stopped, code);
  }
});

test('teto de chamadas: recusa antes da chamada que passaria do teto', () => {
  const breaker = new ExamBreaker(undefined, 2);
  breaker.admit(); breaker.called();
  breaker.admit(); breaker.called();
  assert.throws(() => breaker.admit(), (error: unknown) => error instanceof ExamStop && error.stopCode === EXAM_MODEL_CALL_LIMIT);
  assert.equal(breaker.calls, 2);
});

test('pré-voo: proxy parado, fora da rede, banco caído e imagem ausente recusam com EXAM_DEPENDENCY_DOWN e dizem qual', async () => {
  const egress = {mode: 'enforce' as const};
  const docker = (answers: Record<string, string | Error>) => async (args: readonly string[]) => {
    const answer = answers[args[0] === 'image' ? 'image' : 'inspect'];
    if (answer instanceof Error || answer === undefined) throw answer ?? new Error('no');
    return answer;
  };
  const down = async (input: Parameters<typeof examPreflight>[0]) => {
    try { await examPreflight(input); } catch (error) { assert.ok(error instanceof ExamDependencyDown); assert.equal(error.code, 'EXAM_DEPENDENCY_DOWN'); return error; }
    assert.fail('o pré-voo devia recusar');
  };
  const previous = process.env.AC_PERSONAL_EGRESS;
  delete process.env.AC_PERSONAL_EGRESS;
  try {
    assert.equal((await down({egress, docker: docker({inspect: 'false {"ac-native-provider":{}}'})})).detail, 'ac-provider-egress parado');
    assert.equal((await down({egress, docker: docker({inspect: new Error('No such object')})})).detail, 'ac-provider-egress ausente');
    assert.match((await down({egress, docker: docker({inspect: 'true {"bridge":{}}'})})).detail, /fora da rede ac-native-provider/);
    const ok = docker({inspect: 'true {"bridge":{},"ac-native-provider":{}}', image: 'sha256:x'});
    assert.equal((await down({egress, docker: ok, database: async () => { throw new Error('ECONNREFUSED'); }})).dependency, 'banco');
    assert.equal((await down({egress, docker: docker({inspect: 'true {"ac-native-provider":{}}', image: new Error('missing')}), images: ['sha256:abc']})).dependency, 'imagem fixada');
    await examPreflight({egress, docker: ok, database: async () => undefined, images: ['sha256:abc']});
    // Sem proxy pessoal ligado, o proxy não é conferido.
    await examPreflight({egress: {mode: 'off'}, docker: docker({}), database: async () => undefined});
  } finally {
    if (previous === undefined) delete process.env.AC_PERSONAL_EGRESS; else process.env.AC_PERSONAL_EGRESS = previous;
  }
});
