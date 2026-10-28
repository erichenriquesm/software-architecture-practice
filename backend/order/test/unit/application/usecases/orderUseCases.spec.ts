import { describe, expect, test } from 'vitest';
import { AcceptOrder } from '../../../../src/application/usecases/acceptOrder.js';
import { ApplyFill } from '../../../../src/application/usecases/applyFill.js';
import { CancelOrder } from '../../../../src/application/usecases/cancelOrder.js';
import { ExpireOrder } from '../../../../src/application/usecases/expireOrder.js';
import { GetOrders } from '../../../../src/application/usecases/getOrders.js';
import { OrderStore } from '../../../../src/application/usecases/orderStore.js';
import { PlaceOrder } from '../../../../src/application/usecases/placeOrder.js';
import { RegisterRemoval } from '../../../../src/application/usecases/registerRemoval.js';
import { RejectOrder } from '../../../../src/application/usecases/rejectOrder.js';
import { ConcurrentOrderUpdateError, InvalidOrderDataError, NotOrderOwnerError, OrderNotFoundError } from '../../../../src/domain/errors.js';
import { OrderId } from '../../../../src/domain/valueObjects/orderId.js';
import { FakeMarketCatalog } from '../../../fakes/fakeMarketCatalog.js';
import { fixedClock, fixedIds } from '../../../fakes/fixedSystem.js';
import { InMemoryOrderRepository } from '../../../fakes/inMemoryOrderRepository.js';
import { RecordingDomainEventDispatcher } from '../../../fakes/recordingDomainEventDispatcher.js';
import { RecordingTransactionRunner } from '../../../fakes/recordingTransactionRunner.js';

const accountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
const otherAccount = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a70';
const orderId = '0199d5f4-2b9a-7c3e-9a51-000000000001';
const now = new Date('2026-10-28T12:00:00Z');
const placeOrderInput = { accountId, marketId: 'BTC-USD', side: 'buy', quantity: '1', price: '100' };

const orderUseCases = (clockNow = now) => {
  const repository = new InMemoryOrderRepository();
  const dispatcher = new RecordingDomainEventDispatcher();
  const store = new OrderStore(repository, new RecordingTransactionRunner(), dispatcher);
  const clock = fixedClock(clockNow);
  return {
    repository,
    dispatcher,
    placeOrder: new PlaceOrder(store, new FakeMarketCatalog(), fixedIds(orderId), clock),
    cancelOrder: new CancelOrder(store, clock),
    acceptOrder: new AcceptOrder(store, clock),
    rejectOrder: new RejectOrder(store),
    applyFill: new ApplyFill(store),
    registerRemoval: new RegisterRemoval(store),
  };
};

const statusOf = async (useCases: ReturnType<typeof orderUseCases>) => (await useCases.repository.findById(OrderId.from(orderId)))?.status();
const eventTypes = (useCases: ReturnType<typeof orderUseCases>) => useCases.dispatcher.dispatched.map((event) => event.type);

describe('Use case: PlaceOrder', () => {
  test('Should save a pending order and dispatch OrderPlaced, answering only the order id', async () => {
    // Given
    const useCases = orderUseCases();

    // When
    const placedId = await useCases.placeOrder.execute(placeOrderInput);

    // Then
    expect(placedId).toBe(orderId);
    expect(await statusOf(useCases)).toBe('pending');
    expect(eventTypes(useCases)).toEqual(['OrderPlaced']);
  });

  test('Should reject a market the catalog does not have', async () => {
    // Given
    const useCases = orderUseCases();

    // When & Then
    await expect(useCases.placeOrder.execute({ ...placeOrderInput, marketId: 'ETH-USD' })).rejects.toBeInstanceOf(InvalidOrderDataError);
  });
});

describe('Use cases: AcceptOrder and RejectOrder (S2)', () => {
  test('Should accept and dispatch OrderAccepted, retrying after a conflicting change', async () => {
    // Given
    const useCases = orderUseCases();
    await useCases.placeOrder.execute(placeOrderInput);
    useCases.repository.conflictsToSimulate = 1;

    // When
    await useCases.acceptOrder.execute(orderId);

    // Then
    expect(await statusOf(useCases)).toBe('open');
    expect(eventTypes(useCases)).toEqual(['OrderPlaced', 'OrderAccepted']);
  });

  test('Should give up after three conflicts', async () => {
    // Given
    const useCases = orderUseCases();
    await useCases.placeOrder.execute(placeOrderInput);
    useCases.repository.conflictsToSimulate = 3;

    // When & Then
    await expect(useCases.acceptOrder.execute(orderId)).rejects.toBeInstanceOf(ConcurrentOrderUpdateError);
  });

  test('Should reject with the wallet reason and refuse an unknown reason or order', async () => {
    // Given
    const useCases = orderUseCases();
    await useCases.placeOrder.execute(placeOrderInput);

    // When
    await useCases.rejectOrder.execute(orderId, 'INSUFFICIENT_FUNDS');

    // Then
    expect(await statusOf(useCases)).toBe('rejected');
    await expect(useCases.rejectOrder.execute(orderId, 'BECAUSE')).rejects.toBeInstanceOf(InvalidOrderDataError);
    await expect(useCases.acceptOrder.execute('0199d5f4-2b9a-7c3e-9a51-000000000009')).rejects.toBeInstanceOf(OrderNotFoundError);
  });
});

describe('Use case: CancelOrder', () => {
  test('Should cancel a pending order at once and publish order.voided', async () => {
    // Given
    const useCases = orderUseCases();
    await useCases.placeOrder.execute(placeOrderInput);

    // When
    const status = await useCases.cancelOrder.execute(orderId, accountId);

    // Then
    expect(status).toBe('cancelled');
    expect(eventTypes(useCases)).toEqual(['OrderPlaced', 'OrderVoided']);
  });

  test('Should ask the book to remove an open order and answer cancelling', async () => {
    // Given
    const useCases = orderUseCases();
    await useCases.placeOrder.execute(placeOrderInput);
    await useCases.acceptOrder.execute(orderId);

    // When
    const status = await useCases.cancelOrder.execute(orderId, accountId);

    // Then
    expect(status).toBe('cancelling');
    expect(eventTypes(useCases).at(-1)).toBe('OrderCancelRequested');
  });

  test('Should refuse a cancel from another account', async () => {
    // Given
    const useCases = orderUseCases();
    await useCases.placeOrder.execute(placeOrderInput);

    // When & Then
    await expect(useCases.cancelOrder.execute(orderId, otherAccount)).rejects.toBeInstanceOf(NotOrderOwnerError);
  });
});

describe('Use cases: ApplyFill, RegisterRemoval and ExpireOrder', () => {
  test('Should end cancelled after a removal and a late fill', async () => {
    // Given
    const useCases = orderUseCases();
    await useCases.placeOrder.execute({ ...placeOrderInput, quantity: '10' });
    await useCases.acceptOrder.execute(orderId);

    // When
    await useCases.registerRemoval.execute({ orderId, remainingQuantity: '7', reason: 'CANCELLED' });
    await useCases.applyFill.execute({ orderId, tradeId: 't-1', quantity: '3', price: '100' });

    // Then
    expect(await statusOf(useCases)).toBe('cancelled');
  });

  test('Should expire a pending order once the timeout passed', async () => {
    // Given
    const placed = orderUseCases();
    await placed.placeOrder.execute(placeOrderInput);
    const store = new OrderStore(placed.repository, new RecordingTransactionRunner(), placed.dispatcher);
    const expireOrder = new ExpireOrder(store, fixedClock(new Date(now.getTime() + 120_001)), 120_000);

    // When
    await expireOrder.execute(orderId);

    // Then
    expect(await statusOf(placed)).toBe('expired');
    expect(eventTypes(placed).at(-1)).toBe('OrderVoided');
  });

  test('Should refuse an unknown status filter', async () => {
    // Given
    const getOrders = new GetOrders({ findById: async () => undefined, listByAccount: async () => [], listPendingCreatedBefore: async () => [] });

    // When & Then
    await expect(getOrders.execute(accountId, 'lost')).rejects.toBeInstanceOf(InvalidOrderDataError);
    await expect(getOrders.execute(accountId, 'open')).resolves.toEqual([]);
  });
});
