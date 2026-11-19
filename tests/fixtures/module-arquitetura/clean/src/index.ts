import {handleOrderRequest} from './routes/orders.js';
import {InMemoryOrderStore} from './infra/memory-store.js';

export function bootApplication(orderId: string, amountCents: number): string {
  const store = new InMemoryOrderStore();
  return handleOrderRequest(store, orderId, amountCents);
}
