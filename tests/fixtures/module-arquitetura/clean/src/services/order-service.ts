import {calculateOrderTotal, type OrderRecord} from '../domain/order.js';
import {formatCurrencyCents} from '../shared/format.js';

export interface OrderRepository {
  save(record: OrderRecord): void;
}

export function processOrder(repo: OrderRepository, orderId: string, amountCents: number): string {
  const total = calculateOrderTotal(amountCents, 10);
  repo.save({id: orderId, totalCents: total});
  return `${orderId}:${formatCurrencyCents(total)}`;
}
