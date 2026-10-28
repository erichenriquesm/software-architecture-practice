import type { OrderBook } from '../../domain/entities/orderBook.js';
import type { MarketId } from '../../domain/valueObjects/marketId.js';

export interface OrderBookRepository {
  /** The book of the market; an empty one when nothing was ever placed there. */
  load(marketId: MarketId): Promise<OrderBook>;
  /** Saves entries, trades and sequence. Throws ConcurrentBookUpdateError when the stored sequence moved. */
  save(book: OrderBook): Promise<void>;
}
