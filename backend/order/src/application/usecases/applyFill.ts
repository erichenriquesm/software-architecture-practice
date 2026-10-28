import { OrderId } from '../../domain/valueObjects/orderId.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import type { ApplyFillInput } from '../dtos/applyFillDto.js';
import type { OrderStore } from './orderStore.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';

/** Saga S3: one side of a trade executed this order. The consumer calls it once per order of the trade. */
export class ApplyFill implements UseCase<[input: ApplyFillInput], void> {
  constructor(private readonly orderStore: OrderStore) {}

  async execute(input: ApplyFillInput): Promise<void> {
    const orderId = OrderId.from(input.orderId);
    const quantity = Quantity.from(input.quantity);
    const price = Price.from(input.price);
    await retryOnConflict(() => this.orderStore.change(orderId, (order) => order.applyFill(quantity, price)));
  }
}
