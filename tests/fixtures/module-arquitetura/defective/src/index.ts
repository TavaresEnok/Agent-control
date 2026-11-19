import {handleOrderRequest} from './routes/orders.js';
import {computeLegacyInvoice} from './services/billing-legacy.js';
import {computeModernInvoice} from './services/billing-modern.js';
import {startCycleChain} from './services/cycle-alpha.js';
import {evaluateRiskMatrix} from './services/complex-engine.js';

export function bootDefectiveApp(orderId: string, amountCents: number): string {
  const routed = handleOrderRequest(orderId, amountCents);
  const a = computeLegacyInvoice([{qty: 2, unitCents: 500, taxRate: 0.1}]);
  const b = computeModernInvoice([{qty: 2, unitCents: 500, taxRate: 0.1}]);
  const c = startCycleChain(1);
  const risk = evaluateRiskMatrix(3, true, false, 150, 'vip');
  return `${routed}:${a}:${b}:${c}:${risk}`;
}
