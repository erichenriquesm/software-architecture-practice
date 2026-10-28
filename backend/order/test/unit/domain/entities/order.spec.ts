import { describe, expect, test } from 'vitest';
import { Order } from '../../../../src/domain/entities/order.js';
import { FillExceedsQuantityError, InvalidOrderDataError, InvalidOrderTransitionError } from '../../../../src/domain/errors.js';
import { AccountId } from '../../../../src/domain/valueObjects/accountId.js';
import { MarketFilters } from '../../../../src/domain/valueObjects/marketFilters.js';
import { MarketId } from '../../../../src/domain/valueObjects/marketId.js';
import { OrderId } from '../../../../src/domain/valueObjects/orderId.js';
import { Price } from '../../../../src/domain/valueObjects/price.js';
import { Quantity } from '../../../../src/domain/valueObjects/quantity.js';
import { Side } from '../../../../src/domain/valueObjects/side.js';

const now = new Date('2026-10-28T12:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);
const timeout = 120_000;
const btcUsd = new MarketFilters(Price.from('0.01'), Quantity.from('0.00001'), Quantity.from('0.00001'), Quantity.from('5'));

const place = (quantity = '10', price = '100') =>
  Order.place({
    orderId: OrderId.from('0199d5f4-2b9a-7c3e-9a51-000000000001'),
    accountId: AccountId.from('0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69'),
    marketId: MarketId.from('BTC-USD'),
    side: Side.from('buy'),
    quantity: Quantity.from(quantity),
    price: Price.from(price),
    filters: btcUsd,
    now,
  });

const open = (quantity = '10') => {
  const order = place(quantity);
  order.markReserved(now);
  order.pullEvents();
  return order;
};

const fill = (order: Order, quantity: string, price = '100') => order.applyFill(Quantity.from(quantity), Price.from(price));
const eventTypes = (order: Order) => order.pullEvents().map((event) => event.type);

describe('Order: placing (filters, Q11)', () => {
  test('Should start pending and announce OrderPlaced', () => {
    // When
    const order = place();

    // Then
    expect(order.status()).toBe('pending');
    expect(eventTypes(order)).toEqual(['OrderPlaced']);
  });

  test.each([
    ['a price off the tick', '1', '100.005'],
    ['a quantity off the step', '0.000015', '100000'],
    ['a value below the minimum notional', '0.01', '100'],
  ])('Should reject %s instead of rounding', (_case, quantity, price) => {
    // When & Then
    expect(() => place(quantity, price)).toThrowError(InvalidOrderDataError);
  });
});

describe('Order: derived status, one row per rule', () => {
  test.each([
    ['rejected', (order: Order) => order.markRejected('INSUFFICIENT_FUNDS')],
    ['expired', (order: Order) => order.expire(later(timeout + 1), timeout)],
    ['cancelled', (order: Order) => order.requestCancel(now)],
    ['pending', () => undefined],
  ])('Should be %s while the reservation decides', (status, act) => {
    // Given
    const order = place();

    // When
    act(order);

    // Then
    expect(order.status()).toBe(status);
  });

  test.each([
    ['open', () => undefined],
    ['partiallyFilled', (order: Order) => fill(order, '4')],
    ['filled', (order: Order) => fill(order, '10')],
    ['cancelling', (order: Order) => order.requestCancel(now)],
    ['cancelled', (order: Order) => order.markRemoved(Quantity.from('10'), 'CANCELLED')],
  ])('Should be %s once in the book', (status, act) => {
    // Given
    const order = open();

    // When
    act(order);

    // Then
    expect(order.status()).toBe(status);
  });
});

describe('Order: saga S2', () => {
  test('Should be accepted only once and ignore a late reservation after it was voided', () => {
    // Given
    const order = place();
    order.pullEvents();

    // When
    order.requestCancel(now);
    order.markReserved(now);

    // Then
    expect(order.status()).toBe('cancelled');
    expect(eventTypes(order)).toEqual(['OrderVoided']);
  });

  test('Should expire only after the timeout and only while pending', () => {
    // Given
    const early = place();
    const accepted = open();

    // When
    early.expire(later(timeout), timeout);
    accepted.expire(later(timeout + 1), timeout);

    // Then
    expect(early.status()).toBe('pending');
    expect(accepted.status()).toBe('open');
  });

  test('Should publish OrderAccepted as the pivot', () => {
    // Given
    const order = place();
    order.pullEvents();

    // When
    order.markReserved(now);

    // Then
    expect(order.pullEvents()).toMatchObject([{ type: 'OrderAccepted', acceptedAt: now }]);
  });
});

describe('Order: fills, average price and cancellation (S3 and S4)', () => {
  test('Should keep the exact fill value of several fills', () => {
    // Given
    const order = open();

    // When
    fill(order, '1', '100');
    fill(order, '2', '101');

    // Then
    expect(order.snapshot.fillQuantity.toString()).toBe('3.00000000');
    expect(order.snapshot.fillValue.toString()).toBe('302.00000000');
  });

  test('Should refuse a fill above the quantity and a fill before acceptance', () => {
    // Given
    const order = open();

    // When & Then
    expect(() => fill(order, '11')).toThrowError(FillExceedsQuantityError);
    expect(() => fill(place(), '1')).toThrowError(InvalidOrderTransitionError);
  });

  test('Should end cancelled with the right numbers when the removal arrives before the last fill', () => {
    // Given: 10 in the book, the user cancels; 3 executed, 7 removed, but the removal comes first
    const order = open();
    order.requestCancel(now);

    // When
    order.markRemoved(Quantity.from('7'), 'CANCELLED');
    const whileWaiting = order.status();
    fill(order, '3');

    // Then
    expect(whileWaiting).toBe('cancelling');
    expect(order.status()).toBe('cancelled');
    expect(order.snapshot.fillQuantity.toString()).toBe('3.00000000');
  });

  test('Should go back to filled when the cancel is rejected because everything executed', () => {
    // Given
    const order = open();
    order.requestCancel(now);
    fill(order, '10');

    // When
    order.cancelRejected();

    // Then
    expect(order.status()).toBe('filled');
  });

  test('Should refuse to cancel a filled or rejected order', () => {
    // Given
    const filled = open();
    fill(filled, '10');
    const rejected = place();
    rejected.markRejected('WALLET_NOT_FOUND');

    // When & Then
    expect(() => filled.requestCancel(now)).toThrowError(InvalidOrderTransitionError);
    expect(() => rejected.requestCancel(now)).toThrowError(InvalidOrderTransitionError);
  });

  test('Should end cancelled with the reason when self-trade prevention removes it', () => {
    // Given
    const order = open();

    // When
    order.markRemoved(Quantity.from('10'), 'SELF_TRADE_PREVENTION');

    // Then
    expect(order.status()).toBe('cancelled');
    expect(order.statusReason()).toBe('SELF_TRADE_PREVENTION');
  });

  test('Should ask the book to remove an order that is in it', () => {
    // Given
    const order = open();

    // When
    order.requestCancel(now);

    // Then
    expect(eventTypes(order)).toEqual(['OrderCancelRequested']);
  });
});
