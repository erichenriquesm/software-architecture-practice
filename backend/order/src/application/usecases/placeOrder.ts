import { Order } from '../../domain/entities/order.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import { MarketId } from '../../domain/valueObjects/marketId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import { Side } from '../../domain/valueObjects/side.js';
import type { Clock } from '../contracts/clock.js';
import type { IdGenerator } from '../contracts/idGenerator.js';
import type { MarketCatalog } from '../contracts/marketCatalog.js';
import type { PlaceOrderInput } from '../dtos/placeOrderDto.js';
import type { OrderStore } from './orderStore.js';
import type { UseCase } from './useCase.js';

/** Step 1 of saga S2: the order is born pending; balance and account are checked by the wallet. */
export class PlaceOrder implements UseCase<[input: PlaceOrderInput], string> {
  constructor(
    private readonly orderStore: OrderStore,
    private readonly marketCatalog: MarketCatalog,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: PlaceOrderInput): Promise<string> {
    const marketId = MarketId.from(input.marketId);
    const order = Order.place({
      orderId: OrderId.from(this.idGenerator.next()),
      accountId: AccountId.from(input.accountId),
      marketId,
      side: Side.from(input.side),
      quantity: Quantity.from(input.quantity),
      price: Price.from(input.price),
      filters: this.marketCatalog.filtersOf(marketId),
      now: this.clock.now(),
    });
    await this.orderStore.persist(order);
    return order.snapshot.orderId.value;
  }
}
