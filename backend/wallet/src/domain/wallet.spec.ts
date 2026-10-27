import { describe, expect, test } from 'vitest';
import { InsufficientFundsError, InvalidWalletDataError, ReservationNotFoundError } from './errors.js';
import type { Asset, Market } from './valueObjects.js';
import { Amount } from './valueObjects.js';
import { Wallet } from './wallet.js';
import type { BalanceChanged, WalletEvent } from './walletEvents.js';

const btc: Asset = { assetId: 'BTC', precision: 8 };
const usd: Asset = { assetId: 'USD', precision: 2 };
const market: Market = { marketId: 'BTC-USD', base: btc, quote: usd };
const now = new Date('2026-10-27T12:00:00Z');
const accountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
const buyOrder = '0199d5f4-0000-7000-8000-000000000001';
const sellOrder = '0199d5f4-0000-7000-8000-000000000002';

const amount = (value: string) => Amount.of('amount', value);
const balances = (wallet: Wallet) =>
  Object.fromEntries([...wallet.snapshotBalances()].map(([assetId, balance]) => [assetId, [balance.available.toString(), balance.reserved.toString()]]));
const fundedWallet = (deposits: Record<string, string>) => {
  const wallet = Wallet.open(accountId, now);
  for (const [assetId, quantity] of Object.entries(deposits)) wallet.deposit(assetId === 'BTC' ? btc : usd, quantity, 'seed', now);
  wallet.pullEvents();
  wallet.pullMovements();
  return wallet;
};
const typesOf = (events: WalletEvent[]) => events.map((event) => event.type);

describe('Wallet deposits and withdrawals', () => {
  test('Should add to available, bump the version and emit BalanceChanged with the final state', () => {
    // Given
    const wallet = Wallet.open(accountId, now);

    // When
    wallet.deposit(usd, '1000.50', 'dep-1', now);

    // Then
    expect(balances(wallet)).toEqual({ USD: ['1000.50000000', '0.00000000'] });
    expect(wallet.currentVersion).toBe(1);
    expect(wallet.pullEvents()).toEqual([
      { type: 'BalanceChanged', accountId, assetId: 'USD', available: '1000.50000000', reserved: '0.00000000', version: 1, occurredAt: now },
    ]);
    expect(wallet.pullMovements()).toEqual([
      { assetId: 'USD', availableDelta: '1000.50000000', reservedDelta: '0.00000000', reason: 'DEPOSIT', referenceId: 'dep-1' },
    ]);
  });

  test.each([
    ['zero', usd, '0'],
    ['a negative amount', usd, '-5'],
    ['more decimals than USD allows', usd, '10.001'],
    ['more decimals than BTC allows', btc, '0.000000001'],
    ['text', usd, 'ten'],
  ])('Should reject depositing %s', (_case, asset, quantity) => {
    expect(() => Wallet.open(accountId, now).deposit(asset, quantity, 'x', now)).toThrowError(InvalidWalletDataError);
  });

  test('Should withdraw only from available, never from reserved', () => {
    // Given
    const wallet = fundedWallet({ USD: '100' });
    wallet.reserve({ orderId: buyOrder, market, side: 'buy', quantity: amount('0.001'), price: amount('60000') }, now);

    // When & Then
    expect(() => wallet.withdraw(usd, '50', 'w-1', now)).toThrowError(InsufficientFundsError);
    wallet.withdraw(usd, '40', 'w-2', now);
    expect(balances(wallet)).toEqual({ USD: ['0.00000000', '60.00000000'] });
  });
});

describe('Wallet reservations', () => {
  test('Should reserve quantity x price of the quote asset for a buy', () => {
    // Given
    const wallet = fundedWallet({ USD: '100000' });

    // When
    wallet.reserve({ orderId: buyOrder, market, side: 'buy', quantity: amount('1.5'), price: amount('60000') }, now);

    // Then
    expect(balances(wallet)).toEqual({ USD: ['10000.00000000', '90000.00000000'] });
    expect(typesOf(wallet.pullEvents())).toEqual(['FundsReserved', 'BalanceChanged']);
  });

  test('Should reserve the base quantity for a sell', () => {
    // Given
    const wallet = fundedWallet({ BTC: '2' });

    // When
    wallet.reserve({ orderId: sellOrder, market, side: 'sell', quantity: amount('0.5'), price: amount('70000') }, now);

    // Then
    expect(balances(wallet)).toEqual({ BTC: ['1.50000000', '0.50000000'] });
  });

  test('Should reject with an event, not an exception, when available funds do not cover it, counting open reservations', () => {
    // Given
    const wallet = fundedWallet({ USD: '100' });
    wallet.reserve({ orderId: buyOrder, market, side: 'buy', quantity: amount('0.001'), price: amount('60000') }, now);
    wallet.pullEvents();

    // When
    wallet.reserve({ orderId: sellOrder, market, side: 'buy', quantity: amount('0.001'), price: amount('60000') }, now);

    // Then
    expect(wallet.pullEvents()).toEqual([
      { type: 'FundsReservationRejected', orderId: sellOrder, accountId, reason: 'INSUFFICIENT_FUNDS', occurredAt: now },
    ]);
    expect(balances(wallet)).toEqual({ USD: ['40.00000000', '60.00000000'] });
  });

  test('Should ignore a repeated reservation for the same order', () => {
    // Given
    const wallet = fundedWallet({ USD: '1000' });
    const order = { orderId: buyOrder, market, side: 'buy' as const, quantity: amount('0.01'), price: amount('50000') };
    wallet.reserve(order, now);
    wallet.pullEvents();

    // When
    wallet.reserve(order, now);

    // Then
    expect(wallet.pullEvents()).toEqual([]);
    expect(balances(wallet)).toEqual({ USD: ['500.00000000', '500.00000000'] });
  });
});

describe('Wallet settlement', () => {
  test('Should settle the buyer at the maker price and give back the difference to the limit', () => {
    // Given: buyer reserved 1 BTC at a 83 000 limit and the trade happened at 82 400
    const wallet = fundedWallet({ USD: '100000' });
    wallet.reserve({ orderId: buyOrder, market, side: 'buy', quantity: amount('1'), price: amount('83000') }, now);

    // When
    wallet.settleAsBuyer({ tradeId: 't-1', orderId: buyOrder, market, quantity: amount('1'), price: amount('82400') }, now);

    // Then
    expect(balances(wallet)).toEqual({ USD: ['17600.00000000', '0.00000000'], BTC: ['1.00000000', '0.00000000'] });
    expect(wallet.hasOpenReservation(buyOrder)).toBe(false);
  });

  test('Should settle the seller: BTC leaves the reserved balance and USD arrives at the trade price', () => {
    // Given
    const wallet = fundedWallet({ BTC: '10' });
    wallet.reserve({ orderId: sellOrder, market, side: 'sell', quantity: amount('5'), price: amount('82400') }, now);

    // When
    wallet.settleAsSeller({ tradeId: 't-1', orderId: sellOrder, market, quantity: amount('5'), price: amount('83000') }, now);

    // Then
    expect(balances(wallet)).toEqual({ BTC: ['5.00000000', '0.00000000'], USD: ['415000.00000000', '0.00000000'] });
  });

  test('Should end with the same balances whether the trade or the removal arrives first', () => {
    // Given: buy 2 BTC at 60 000 limit, 0.5 filled at 59 000, remaining 1.5 cancelled
    const reserveThen = () => {
      const wallet = fundedWallet({ USD: '200000' });
      wallet.reserve({ orderId: buyOrder, market, side: 'buy', quantity: amount('2'), price: amount('60000') }, now);
      return wallet;
    };
    const trade = { tradeId: 't-1', orderId: buyOrder, market, quantity: amount('0.5'), price: amount('59000') };
    const tradeFirst = reserveThen();
    const removalFirst = reserveThen();

    // When
    tradeFirst.settleAsBuyer(trade, now);
    tradeFirst.releaseRemaining(buyOrder, amount('1.5'), now);
    removalFirst.releaseRemaining(buyOrder, amount('1.5'), now);
    removalFirst.settleAsBuyer(trade, now);

    // Then
    expect(balances(tradeFirst)).toEqual(balances(removalFirst));
    expect(balances(tradeFirst)).toEqual({ USD: ['170500.00000000', '0.00000000'], BTC: ['0.50000000', '0.00000000'] });
  });

  test('Should refuse to settle an order without an open reservation', () => {
    expect(() =>
      fundedWallet({ USD: '10' }).settleAsBuyer({ tradeId: 't', orderId: buyOrder, market, quantity: amount('1'), price: amount('1') }, now),
    ).toThrowError(ReservationNotFoundError);
  });
});

describe('Wallet compensation', () => {
  test('Should void an open reservation, release everything left and emit BalanceChanged', () => {
    // Given
    const wallet = fundedWallet({ BTC: '1' });
    wallet.reserve({ orderId: sellOrder, market, side: 'sell', quantity: amount('0.4'), price: amount('70000') }, now);
    wallet.pullEvents();

    // When
    wallet.voidReservation(sellOrder, now);

    // Then
    expect(balances(wallet)).toEqual({ BTC: ['1.00000000', '0.00000000'] });
    const [event] = wallet.pullEvents() as BalanceChanged[];
    expect(event).toMatchObject({ type: 'BalanceChanged', assetId: 'BTC', available: '1.00000000', reserved: '0.00000000' });
    expect(wallet.hasOpenReservation(sellOrder)).toBe(false);
  });

  test('Should do nothing when there is no open reservation to void', () => {
    // Given
    const wallet = fundedWallet({ BTC: '1' });

    // When
    wallet.voidReservation(sellOrder, now);

    // Then
    expect(wallet.pullEvents()).toEqual([]);
  });
});
