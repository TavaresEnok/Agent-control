import type {OrderRecord} from '../domain/order.js';
import type {OrderRepository} from '../services/order-service.js';

export class InMemoryOrderStore implements OrderRepository {
  private readonly records = new Map<string, OrderRecord>();

  save(record: OrderRecord): void {
    this.records.set(record.id, record);
  }
}
