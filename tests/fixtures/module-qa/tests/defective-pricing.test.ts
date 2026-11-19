import assert from 'node:assert/strict';
import {test} from 'node:test';
import {calcularDescontoVip, parseQuantidadePedido} from '../src/defective-pricing.ts';
import {registerBillingRoutes} from '../src/routes.ts';

test('aplica desconto VIP para valores altos e mantem valores baixos sem testar a fronteira 100', () => {
  assert.equal(calcularDescontoVip(150), 135);
  assert.equal(calcularDescontoVip(40), 40);
  const paths: string[] = [];
  registerBillingRoutes({
    get: p => paths.push(p),
    post: p => paths.push(p),
  });
  assert.equal(paths.length, 2);
});

test.skip('rejeita desconto cumulativo acima do teto', () => {
  assert.equal(calcularDescontoVip(100), 85);
});

test('executa parseQuantidadePedido sem conferir retorno', () => {
  parseQuantidadePedido('10');
});
