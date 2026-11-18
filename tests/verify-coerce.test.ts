import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coerceConfirmResult, coerceExamResult, coerceMapResult} from '../src/verify-runtime.ts';
import {ConfirmResult, ExamResult, MapResult} from '../src/verify-types.ts';

test('o exame solto vira alta em package.json e esconde token no texto', () => {
  const secret = ['ghp', 'VerifyLabFicticioNaoUsar00000000'].join('_');
  const parsed = ExamResult.parse(coerceExamResult({
    kind: 'exame',
    slice: 'fatia-1',
    filesRead: ['package.json', 'src/store.js'],
    checklist: [{id: 'ASVS5-V1-SANITIZACAO', status: 'ok', evidence: 'visto'}],
    findings: [{
      title: 'minimist 0.0.8 vulnerável',
      severity: 'high',
      file: 'package.json',
      line: 6,
      detail: `Dependência antiga ${secret}`,
      fix: 'Atualizar.',
      cwe: 'CWE-1395',
    }],
  }));
  assert.equal('slice' in parsed, false);
  assert.deepEqual(parsed.checklist, ['ASVS5-V1-SANITIZACAO']);
  assert.equal(parsed.findings[0]?.severity, 'alta');
  assert.equal(parsed.findings[0]?.file, 'package.json');
  assert.equal(parsed.findings[0]?.line, 6);
  assert.equal(parsed.findings[0]?.suggestion, 'Atualizar.');
  assert.equal(parsed.findings[0]?.reference, 'CWE-1395');
  assert.equal(parsed.findings[0]?.snippet, '');
  assert.equal(parsed.findings[0]?.scenario.includes(secret), false);
  assert.match(parsed.findings[0]?.scenario ?? '', /Dependência antiga/);
});

test('surfaces objeto e proof objeto entram no esquema', () => {
  const map = MapResult.parse(coerceMapResult({
    kind: 'mapa',
    extra: true,
    routes: [{method: 'GET', path: '/admin', file: 'src/app.js', line: 6, note: 'ignorar'}],
    surfaces: [{kind: 'http', file: 'src/app.js', line: 6, detail: 'rota admin'}],
  }));
  assert.equal(map.routes[0]?.path, '/admin');
  assert.equal(map.surfaces.length, 1);
  assert.match(map.surfaces[0] ?? '', /http/);
  assert.match(map.surfaces[0] ?? '', /src\/app\.js/);
  const confirm = ConfirmResult.parse(coerceConfirmResult({
    kind: 'confirmacao',
    status: 'descartado',
    reason: '',
    proof: {arquivo: '/repository/Dockerfile', evidencia_fornecida: 'linha 4'},
  }));
  assert.equal(confirm.status, 'descartado');
  assert.equal(confirm.reason, 'Sem justificativa.');
  assert.equal(typeof confirm.proof, 'string');
  assert.match(confirm.proof, /Dockerfile/);
});

test('json vazio continua inválido', () => {
  assert.equal(ExamResult.safeParse(coerceExamResult({})).success, false);
  assert.equal(MapResult.safeParse(coerceMapResult({})).success, false);
  assert.equal(ConfirmResult.safeParse(coerceConfirmResult({})).success, false);
  assert.equal(ConfirmResult.safeParse(coerceConfirmResult({status: 'talvez', proof: 'x'})).success, false);
});
