import type { IncomingOrder } from '../../domain/entities/orderBook.js';
import { InvalidBookDataError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import { MarketId } from '../../domain/valueObjects/marketId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import { Side } from '../../domain/valueObjects/side.js';
import type { Clock } from '../contracts/clock.js';
import type { IdGenerator } from '../contracts/idGenerator.js';
import type { ExecuteOrderInput } from '../dtos/executeOrderDto.js';
import type { BookStore } from './bookStore.js';
import type { UseCase } from './useCase.js';

const acceptedAtOf = (value: string): Date => {
  const acceptedAt = new Date(value);
  if (Number.isNaN(acceptedAt.getTime())) throw new InvalidBookDataError('acceptedAt', 'must be a date-time');
  return acceptedAt;
};

/** Saga S2 step 4 (after the pivot) and saga S3 pivot: the order enters the book and may trade. */
export class ExecuteOrder implements UseCase<[input: ExecuteOrderInput], void> {
  constructor(
    private readonly bookStore: BookStore,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: ExecuteOrderInput): Promise<void> {
    const order: IncomingOrder = {
      orderId: OrderId.from(input.orderId),
      accountId: AccountId.from(input.accountId),
      side: Side.from(input.side),
      quantity: Quantity.from(input.quantity),
      price: Price.from(input.price),
      acceptedAt: acceptedAtOf(input.acceptedAt),
    };
    await this.bookStore.change(MarketId.from(input.marketId), (book) => book.place(order, this.clock.now(), () => this.idGenerator.next()));
  }
}
