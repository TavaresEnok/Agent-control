import assert from 'node:assert/strict';
import {test} from 'node:test';
import {calcularDescontoFidelidade, parseQuantidadeSegura} from '../src/clean-pricing.ts';

test('REQ-01: calcula desconto de fidelidade incluindo a fronteira exata de 100', () => {
  assert.equal(calcularDescontoFidelidade(150), 135);
  assert.equal(calcularDescontoFidelidade(100), 85);
  assert.equal(calcularDescontoFidelidade(40), 40);
});

test('REQ-01: valida quantidade segura positiva e rejeita entradas malformadas', () => {
  assert.equal(parseQuantidadeSegura('1'), 1);
  assert.equal(parseQuantidadeSegura('25'), 25);
  assert.throws(() => parseQuantidadeSegura('0'), /QUANTIDADE_INVALIDA/);
  assert.throws(() => parseQuantidadeSegura('-3'), /QUANTIDADE_INVALIDA/);
  assert.throws(() => parseQuantidadeSegura('abc'), /QUANTIDADE_INVALIDA/);
});

test('QA-VALIDADOR: quantidade aceita limite inferior', () => assert.strictEqual(parseQuantidadeSegura('1'), 1));
test('QA-VALIDADOR: quantidade aceita limite superior', () => assert.strictEqual(parseQuantidadeSegura('9999'), 9999));
test('QA-VALIDADOR: quantidade rejeita zero', () => assert.throws(() => parseQuantidadeSegura('0')));
test('QA-VALIDADOR: quantidade rejeita valor acima do limite', () => assert.throws(() => parseQuantidadeSegura('10000')));
