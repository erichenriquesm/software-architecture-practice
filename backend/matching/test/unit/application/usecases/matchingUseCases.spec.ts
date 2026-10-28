import { describe, expect, test } from 'vitest';
import type { OrderBookRepository } from '../../../../src/application/contracts/orderBookRepository.js';
import { BookStore } from '../../../../src/application/usecases/bookStore.js';
import { ExecuteOrder } from '../../../../src/application/usecases/executeOrder.js';
import { RemoveOrder } from '../../../../src/application/usecases/removeOrder.js';
import { OrderBook } from '../../../../src/domain/entities/orderBook.js';
import { InvalidBookDataError } from '../../../../src/domain/errors.js';
import type { MarketId } from '../../../../src/domain/valueObjects/marketId.js';
import { fixedClock, fixedIds } from '../../../fakes/fixedSystem.js';
import { RecordingDomainEventDispatcher } from '../../../fakes/recordingDomainEventDispatcher.js';
import { RecordingTransactionRunner } from '../../../fakes/recordingTransactionRunner.js';

/** Keeps one live book per market, like a database that always returns the latest state. */
class InMemoryOrderBookRepository implements OrderBookRepository {
  readonly books = new Map<string, OrderBook>();
  saves = 0;

  async load(marketId: MarketId): Promise<OrderBook> {
    return this.books.get(marketId.value) ?? OrderBook.empty(marketId);
  }

  async save(book: OrderBook): Promise<void> {
    this.saves += 1;
    this.books.set(book.marketId.value, book);
  }
}

const accepted = (orderId: string, accountId: string, side: string, quantity: string, price: string) => ({
  orderId,
  accountId,
  marketId: 'BTC-USD',
  side,
  quantity,
  price,
  acceptedAt: '2026-10-28T12:00:00.000Z',
});

const matchingUseCases = () => {
  const repository = new InMemoryOrderBookRepository();
  const dispatcher = new RecordingDomainEventDispatcher();
  const store = new BookStore(repository, new RecordingTransactionRunner(), dispatcher);
  const clock = fixedClock(new Date('2026-10-28T12:00:01Z'));
  return {
    repository,
    dispatcher,
    executeOrder: new ExecuteOrder(store, fixedIds('0199d5f4-2b9a-7c3e-9a51-00000000000a'), clock),
    removeOrder: new RemoveOrder(store, clock),
  };
};

const buy = '0199d5f4-2b9a-7c3e-9a51-000000000001';
const sell = '0199d5f4-2b9a-7c3e-9a51-000000000002';
const alice = '0199d5f4-2b9a-7c3e-9a51-0000000000a1';
const bob = '0199d5f4-2b9a-7c3e-9a51-0000000000b1';

describe('Use case: ExecuteOrder', () => {
  test('Should place the order, save the book and dispatch the trade and the snapshot', async () => {
    // Given
    const useCases = matchingUseCases();
    await useCases.executeOrder.execute(accepted(buy, alice, 'buy', '1', '100'));

    // When
    await useCases.executeOrder.execute(accepted(sell, bob, 'sell', '1', '100'));

    // Then
    expect(useCases.dispatcher.dispatched.map((event) => event.type)).toEqual(['BookChanged', 'TradeExecuted', 'BookChanged']);
    expect(useCases.repository.saves).toBe(2);
  });

  test('Should reject an acceptedAt that is not a date', async () => {
    // Given
    const useCases = matchingUseCases();

    // When & Then
    await expect(useCases.executeOrder.execute({ ...accepted(buy, alice, 'buy', '1', '100'), acceptedAt: 'yesterday' })).rejects.toBeInstanceOf(InvalidBookDataError);
  });
});

describe('Use case: RemoveOrder', () => {
  test('Should not save the book when the order is not in it, and still answer NOT_IN_BOOK', async () => {
    // Given
    const useCases = matchingUseCases();

    // When
    await useCases.removeOrder.execute(buy, 'BTC-USD');

    // Then
    expect(useCases.repository.saves).toBe(0);
    expect(useCases.dispatcher.dispatched).toMatchObject([{ type: 'OrderCancelRejected', reason: 'NOT_IN_BOOK' }]);
  });
});
