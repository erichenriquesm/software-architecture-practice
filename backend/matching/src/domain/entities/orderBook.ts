import type { BookChanged } from '../domainEvents/bookChanged.js';
import type { DomainEvent } from '../domainEvents/domainEvent.js';
import type { OrderCancelRejected } from '../domainEvents/orderCancelRejected.js';
import type { OrderRemoved, RemovalReason } from '../domainEvents/orderRemoved.js';
import type { TradeExecuted } from '../domainEvents/tradeExecuted.js';
import type { AccountId } from '../valueObjects/accountId.js';
import type { MarketId } from '../valueObjects/marketId.js';
import type { OrderId } from '../valueObjects/orderId.js';
import type { Price } from '../valueObjects/price.js';
import type { Quantity } from '../valueObjects/quantity.js';
import type { Side } from '../valueObjects/side.js';
import type { Trade } from '../valueObjects/trade.js';
import { AggregateRoot } from './aggregateRoot.js';
import { BookEntry } from './bookEntry.js';
import { BookSide } from './bookSide.js';

export interface IncomingOrder {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: Price;
  readonly acceptedAt: Date;
}

export interface OrderBookSnapshot {
  readonly marketId: MarketId;
  readonly sequence: number;
  readonly nextPriority: number;
  readonly entries: readonly BookEntry[];
}

/**
 * The book of one market and the core rule of the platform: the best bid meets the best ask; a match
 * executes the smaller quantity at the price of the older (maker) order, with the side of the incoming
 * (taker) order; partial and cascading fills; a fully executed order leaves the book; an account never
 * trades with itself (self-trade prevention, "cancel the maker").
 */
export class OrderBook extends AggregateRoot<DomainEvent> {
  private readonly trades: Trade[] = [];
  private readonly upserted = new Map<string, BookEntry>();
  private readonly deleted = new Set<string>();

  private constructor(
    readonly marketId: MarketId,
    readonly savedSequence: number,
    private sequenceNumber: number,
    private nextPriorityNumber: number,
    private readonly bids: BookSide,
    private readonly asks: BookSide,
  ) {
    super();
  }

  static empty(marketId: MarketId): OrderBook {
    return new OrderBook(marketId, 0, 0, 1, BookSide.bids(), BookSide.asks());
  }

  static restore(snapshot: OrderBookSnapshot): OrderBook {
    const bids = BookSide.bids(snapshot.entries.filter((entry) => entry.isBuy()));
    const asks = BookSide.asks(snapshot.entries.filter((entry) => !entry.isBuy()));
    return new OrderBook(snapshot.marketId, snapshot.sequence, snapshot.sequence, snapshot.nextPriority, bids, asks);
  }

  get sequence(): number {
    return this.sequenceNumber;
  }

  get nextPriority(): number {
    return this.nextPriorityNumber;
  }

  isNew(): boolean {
    return this.savedSequence === 0;
  }

  hasChanges(): boolean {
    return this.sequenceNumber !== this.savedSequence;
  }

  /** Entries to insert or update, ids to delete and trades to record: what the repository persists. */
  changes(): { readonly upserted: readonly BookEntry[]; readonly deleted: readonly string[]; readonly trades: readonly Trade[] } {
    return { upserted: [...this.upserted.values()], deleted: [...this.deleted], trades: this.trades };
  }

  bestBid(): BookEntry | undefined {
    return this.bids.best();
  }

  bestAsk(): BookEntry | undefined {
    return this.asks.best();
  }

  /** An order accepted by the order service. Repeated orders are ignored (the book is idempotent too). */
  place(order: IncomingOrder, now: Date, newTradeId: () => string): void {
    if (this.find(order.orderId)) return;
    const taker = BookEntry.of({ ...order, remaining: order.quantity, priority: this.nextPriorityNumber });
    this.nextPriorityNumber += 1;
    this.sequenceNumber += 1;
    const opposite = taker.isBuy() ? this.asks : this.bids;
    while (this.matchNext(taker, opposite, now, newTradeId));
    if (!taker.isFilled()) this.rest(taker);
    this.recordBookChanged(now);
  }

  /** Removes what is left of the order, or tells the order service it is no longer in the book. */
  cancel(orderId: OrderId, now: Date): void {
    const entry = this.find(orderId);
    if (!entry) return this.recordEvent(this.cancelRejected(orderId, now));
    this.sequenceNumber += 1;
    this.removeFromBook(entry, 'CANCELLED', now);
    this.recordBookChanged(now);
  }

  private matchNext(taker: BookEntry, opposite: BookSide, now: Date, newTradeId: () => string): boolean {
    const maker = opposite.best();
    if (!maker || taker.isFilled() || !taker.crosses(maker)) return false;
    if (maker.sameAccountAs(taker)) {
      this.removeFromBook(maker, 'SELF_TRADE_PREVENTION', now);
      return true;
    }
    this.execute(taker, maker, now, newTradeId());
    return true;
  }

  private execute(taker: BookEntry, maker: BookEntry, now: Date, tradeId: string): void {
    const quantity = taker.remaining.min(maker.remaining);
    taker.reduce(quantity);
    maker.reduce(quantity);
    const trade = this.tradeOf(tradeId, taker, maker, quantity, now);
    this.trades.push(trade);
    this.recordEvent(this.tradeExecuted(trade));
    if (!maker.isFilled()) return void this.upserted.set(maker.orderId.value, maker);
    this.sideOf(maker).remove(maker.orderId);
    this.markDeleted(maker);
  }

  private rest(entry: BookEntry): void {
    this.sideOf(entry).insert(entry);
    this.upserted.set(entry.orderId.value, entry);
  }

  private removeFromBook(entry: BookEntry, reason: RemovalReason, now: Date): void {
    this.sideOf(entry).remove(entry.orderId);
    this.markDeleted(entry);
    this.recordEvent(this.orderRemoved(entry, reason, now));
  }

  private markDeleted(entry: BookEntry): void {
    this.upserted.delete(entry.orderId.value);
    this.deleted.add(entry.orderId.value);
  }

  private find(orderId: OrderId): BookEntry | undefined {
    return this.bids.find(orderId) ?? this.asks.find(orderId);
  }

  private sideOf(entry: BookEntry): BookSide {
    return entry.isBuy() ? this.bids : this.asks;
  }

  private tradeOf(tradeId: string, taker: BookEntry, maker: BookEntry, quantity: Quantity, now: Date): Trade {
    const [buy, sell] = taker.isBuy() ? [taker, maker] : [maker, taker];
    const parties = { buyOrderId: buy.orderId, sellOrderId: sell.orderId, buyAccountId: buy.snapshot.accountId, sellAccountId: sell.snapshot.accountId };
    return { tradeId, marketId: this.marketId, ...parties, side: taker.snapshot.side, quantity, price: maker.price, executedAt: now, bookSequence: this.sequenceNumber };
  }

  private tradeExecuted(trade: Trade): TradeExecuted {
    const ids = { buyOrderId: trade.buyOrderId.value, sellOrderId: trade.sellOrderId.value, buyAccountId: trade.buyAccountId.value, sellAccountId: trade.sellAccountId.value };
    return {
      type: 'TradeExecuted',
      tradeId: trade.tradeId,
      marketId: trade.marketId.value,
      ...ids,
      side: trade.side.value,
      quantity: trade.quantity.toString(),
      price: trade.price.toString(),
      bookSequence: trade.bookSequence,
      occurredAt: trade.executedAt,
    };
  }

  private orderRemoved(entry: BookEntry, reason: RemovalReason, now: Date): OrderRemoved {
    const data = entry.snapshot;
    return {
      type: 'OrderRemoved',
      orderId: data.orderId.value,
      accountId: data.accountId.value,
      marketId: this.marketId.value,
      side: data.side.value,
      remainingQuantity: data.remaining.toString(),
      reason,
      occurredAt: now,
    };
  }

  private cancelRejected(orderId: OrderId, now: Date): OrderCancelRejected {
    return { type: 'OrderCancelRejected', orderId: orderId.value, marketId: this.marketId.value, reason: 'NOT_IN_BOOK', occurredAt: now };
  }

  private recordBookChanged(now: Date): void {
    const event: BookChanged = {
      type: 'BookChanged',
      marketId: this.marketId.value,
      sequence: this.sequenceNumber,
      bids: this.bids.levels(),
      asks: this.asks.levels(),
      occurredAt: now,
    };
    this.recordEvent(event);
  }
}
