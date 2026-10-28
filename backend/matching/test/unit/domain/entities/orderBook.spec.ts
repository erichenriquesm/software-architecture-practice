import { describe, expect, test } from 'vitest';
import type { IncomingOrder } from '../../../../src/domain/entities/orderBook.js';
import { OrderBook } from '../../../../src/domain/entities/orderBook.js';
import { AccountId } from '../../../../src/domain/valueObjects/accountId.js';
import { MarketId } from '../../../../src/domain/valueObjects/marketId.js';
import { OrderId } from '../../../../src/domain/valueObjects/orderId.js';
import { Price } from '../../../../src/domain/valueObjects/price.js';
import { Quantity } from '../../../../src/domain/valueObjects/quantity.js';
import { Side } from '../../../../src/domain/valueObjects/side.js';

const now = new Date('2026-10-28T12:00:00Z');
const alice = '0199d5f4-2b9a-7c3e-9a51-0000000000a1';
const bob = '0199d5f4-2b9a-7c3e-9a51-0000000000b1';
const carol = '0199d5f4-2b9a-7c3e-9a51-0000000000c1';

let orderNumber = 0;
const order = (account: string, side: string, quantity: string, price: string): IncomingOrder => {
  orderNumber += 1;
  return {
    orderId: OrderId.from(`0199d5f4-2b9a-7c3e-9a51-${String(orderNumber).padStart(12, '0')}`),
    accountId: AccountId.from(account),
    side: Side.from(side),
    quantity: Quantity.from(quantity),
    price: Price.from(price),
    acceptedAt: now,
  };
};

const newBook = () => {
  let tradeNumber = 0;
  const book = OrderBook.empty(MarketId.from('BTC-USD'));
  const place = (incoming: IncomingOrder) => {
    book.place(incoming, now, () => `trade-${(tradeNumber += 1)}`);
    return book.pullEvents();
  };
  return { book, place };
};

const tradesOf = (events: readonly { type: string }[]) =>
  events.filter((event) => event.type === 'TradeExecuted') as unknown as { side: string; quantity: string; price: string; buyOrderId: string; sellOrderId: string }[];

describe('OrderBook: the example of the objective', () => {
  test('Should trade 5 BTC at 83,000 as a sell, remove the sell and keep 5 of the buy in the book', () => {
    // Given: a buy of 10 BTC at 83,000 rests in the book
    const { book, place } = newBook();
    const buy = order(alice, 'buy', '10', '83000');
    place(buy);

    // When: a sell of 5 BTC at 82,400 arrives
    const sell = order(bob, 'sell', '5', '82400');
    const events = place(sell);

    // Then: quantity is the smaller one, price is the older order's, side is the order that just arrived
    expect(tradesOf(events)).toMatchObject([{ quantity: '5.00000000', price: '83000.00000000', side: 'sell', buyOrderId: buy.orderId.value, sellOrderId: sell.orderId.value }]);
    expect(book.bestAsk()).toBeUndefined();
    expect(book.bestBid()?.remaining.toString()).toBe('5.00000000');
  });
});

describe('OrderBook: price-time priority', () => {
  test('Should use the maker price when the taker is a buy, and the taker side', () => {
    // Given
    const { place } = newBook();
    place(order(alice, 'sell', '1', '100'));

    // When
    const events = place(order(bob, 'buy', '1', '110'));

    // Then
    expect(tradesOf(events)).toMatchObject([{ price: '100.00000000', side: 'buy' }]);
  });

  test('Should match the oldest order first at the same price', () => {
    // Given
    const { place } = newBook();
    const first = order(alice, 'sell', '1', '100');
    place(first);
    place(order(carol, 'sell', '1', '100'));

    // When
    const events = place(order(bob, 'buy', '1', '100'));

    // Then
    expect(tradesOf(events)).toMatchObject([{ sellOrderId: first.orderId.value }]);
  });

  test('Should cascade through several makers and rest what is left at its own price', () => {
    // Given
    const { book, place } = newBook();
    place(order(alice, 'sell', '1', '100'));
    place(order(alice, 'sell', '2', '101'));
    place(order(alice, 'sell', '3', '102'));

    // When: buy 4 up to 101 takes 1 @ 100 and 2 @ 101, and cannot reach 102
    const events = place(order(bob, 'buy', '4', '101'));

    // Then
    expect(tradesOf(events).map((trade) => [trade.quantity, trade.price])).toEqual([
      ['1.00000000', '100.00000000'],
      ['2.00000000', '101.00000000'],
    ]);
    expect([book.bestBid()?.remaining.toString(), book.bestBid()?.price.toString()]).toEqual(['1.00000000', '101.00000000']);
    expect(book.bestAsk()?.price.toString()).toBe('102.00000000');
  });

  test('Should not match when the best bid is below the best ask', () => {
    // Given
    const { book, place } = newBook();
    place(order(alice, 'buy', '1', '99'));

    // When
    const events = place(order(bob, 'sell', '1', '100'));

    // Then
    expect(tradesOf(events)).toEqual([]);
    expect([book.bestBid()?.price.toString(), book.bestAsk()?.price.toString()]).toEqual(['99.00000000', '100.00000000']);
  });

  test('Should ignore an order already in the book', () => {
    // Given
    const { book, place } = newBook();
    const resting = order(alice, 'buy', '1', '99');
    place(resting);

    // When
    const events = place(resting);

    // Then
    expect(events).toEqual([]);
    expect(book.sequence).toBe(1);
  });
});

describe('OrderBook: self-trade prevention (Q9)', () => {
  test('Should remove the maker of the same account and keep matching the next one', () => {
    // Given
    const { place } = newBook();
    const own = order(alice, 'sell', '1', '100');
    place(own);
    place(order(bob, 'sell', '1', '101'));

    // When
    const events = place(order(alice, 'buy', '1', '101'));

    // Then
    expect(events.find((event) => event.type === 'OrderRemoved')).toMatchObject({ orderId: own.orderId.value, reason: 'SELF_TRADE_PREVENTION', remainingQuantity: '1.00000000' });
    expect(tradesOf(events)).toMatchObject([{ price: '101.00000000' }]);
  });

  test('Should rest the taker when only its own maker crossed', () => {
    // Given
    const { book, place } = newBook();
    place(order(alice, 'sell', '1', '100'));

    // When
    place(order(alice, 'buy', '1', '100'));

    // Then
    expect(book.bestAsk()).toBeUndefined();
    expect(book.bestBid()?.price.toString()).toBe('100.00000000');
  });
});

describe('OrderBook: cancellation and snapshot', () => {
  test('Should remove what is left with CANCELLED, and answer NOT_IN_BOOK for an order that is not there', () => {
    // Given
    const { book, place } = newBook();
    const resting = order(alice, 'buy', '3', '99');
    place(resting);

    // When
    book.cancel(resting.orderId, now);
    const removed = book.pullEvents();
    book.cancel(resting.orderId, now);
    const rejected = book.pullEvents();

    // Then
    expect(removed[0]).toMatchObject({ type: 'OrderRemoved', reason: 'CANCELLED', remainingQuantity: '3.00000000' });
    expect(rejected).toMatchObject([{ type: 'OrderCancelRejected', reason: 'NOT_IN_BOOK' }]);
  });

  test('Should publish the levels aggregated by exact price after each change, with a growing sequence', () => {
    // Given
    const { place } = newBook();
    place(order(alice, 'buy', '10', '84500'));

    // When
    const events = place(order(carol, 'buy', '10', '84500'));

    // Then
    expect(events.at(-1)).toMatchObject({ type: 'BookChanged', sequence: 2, bids: [{ price: '84500.00000000', quantity: '20.00000000' }], asks: [] });
  });
});

describe('OrderBook: invariants under random orders', () => {
  test('Should never stay crossed and never trade an account with itself (seed 42)', () => {
    // Given
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const accounts = [alice, bob, carol];
    const { book, place } = newBook();

    for (let index = 0; index < 300; index += 1) {
      // When
      const account = accounts[Math.floor(random() * accounts.length)] ?? alice;
      const side = random() < 0.5 ? 'buy' : 'sell';
      const events = place(order(account, side, String(1 + Math.floor(random() * 5)), String(95 + Math.floor(random() * 11))));

      // Then
      const bid = book.bestBid();
      const ask = book.bestAsk();
      if (bid && ask) expect(bid.price.isGreaterThan(ask.price) || bid.price.toString() === ask.price.toString()).toBe(false);
      const trades = events.filter((event) => event.type === 'TradeExecuted') as unknown as { buyAccountId: string; sellAccountId: string }[];
      for (const trade of trades) expect(trade.buyAccountId).not.toBe(trade.sellAccountId);
    }
  });
});
