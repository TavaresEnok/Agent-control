import {buildRoutePrefix} from '../routes/orders.js';
import {readStoredFactor} from '../infra/memory-store.js';

export function calculateOrderTotal(baseCents: number, discountPercent: number): number {
  if (baseCents <= 0) return 0;
  const prefix = buildRoutePrefix();
  const factor = prefix.length > 0 ? readStoredFactor() : 1;
  const boundedDiscount = Math.min(Math.max(discountPercent, 0), 50);
  return Math.round(baseCents * factor * (1 - boundedDiscount / 100));
}
