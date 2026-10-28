import { InvalidBookDataError } from '../errors.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OrderId {
  private constructor(readonly value: string) {}

  static from(value: string): OrderId {
    if (!uuid.test(value)) throw new InvalidBookDataError('orderId', 'must be a uuid');
    return new OrderId(value.toLowerCase());
  }
}
