import {processOrder, type OrderRepository} from '../services/order-service.js';

export function handleOrderRequest(repo: OrderRepository, orderId: string, amountCents: number): string {
  return processOrder(repo, orderId, amountCents);
}
