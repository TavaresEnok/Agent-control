import {calculateOrderTotal} from '../domain/order.js';
import {formatCurrencyCents} from '../shared/format.js';

export function buildRoutePrefix(): string {
  return '/orders';
}

export function handleOrderRequest(orderId: string, amountCents: number): string {
  const total = calculateOrderTotal(amountCents, 10);
  return `${buildRoutePrefix()}/${orderId}:${formatCurrencyCents(total)}`;
}
