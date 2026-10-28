import type { AccountId } from './accountId.js';
import type { MarketId } from './marketId.js';
import type { OrderId } from './orderId.js';
import type { Price } from './price.js';
import type { Quantity } from './quantity.js';
import type { Side } from './side.js';

/** The result of a match: quantity is the smaller remaining, price is the maker's, side is the taker's. */
export interface Trade {
  readonly tradeId: string;
  readonly marketId: MarketId;
  readonly buyOrderId: OrderId;
  readonly sellOrderId: OrderId;
  readonly buyAccountId: AccountId;
  readonly sellAccountId: AccountId;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: Price;
  readonly executedAt: Date;
  readonly bookSequence: number;
}
