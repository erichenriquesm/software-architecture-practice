import { describe, expect, test } from 'vitest';
import type { ExecutedTrade, OrderToReserve } from '../../../../src/domain/entities/wallet.js';
import { Wallet } from '../../../../src/domain/entities/wallet.js';
import {
  InsufficientFundsError,
  InvalidWalletDataError,
  ReservationNotFoundError,
  ReservationOverdrawnError,
} from '../../../../src/domain/errors.js';
import { AccountId } from '../../../../src/domain/valueObjects/accountId.js';
import { AssetId } from '../../../../src/domain/valueObjects/assetId.js';
import { MarketId } from '../../../../src/domain/valueObjects/marketId.js';
import { OrderId } from '../../../../src/domain/valueObjects/orderId.js';
import { Price } from '../../../../src/domain/valueObjects/price.js';
import { Quantity } from '../../../../src/domain/valueObjects/quantity.js';
import { Side } from '../../../../src/domain/valueObjects/side.js';

const now = new Date('2026-10-28T12:00:00Z');
const btc = AssetId.from('BTC');
const usd = AssetId.from('USD');
const market = MarketId.from('BTC-USD');
const buyOrder = OrderId.from('0199d5f4-2b9a-7c3e-9a51-000000000001');
const sellOrder = OrderId.from('0199d5f4-2b9a-7c3e-9a51-000000000002');

const walletWith = (deposits: Readonly<Record<string, string>>): Wallet => {
  const wallet = Wallet.open(AccountId.from('0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69'));
  for (const [asset, quantity] of Object.entries(deposits)) wallet.deposit(AssetId.from(asset), Quantity.from(quantity), 8, now);
  wallet.pullEvents();
  return wallet;
};

const order = (orderId: OrderId, side: string, quantity: string, price: string): OrderToReserve => ({
  orderId,
  market,
  side: Side.from(side),
  quantity: Quantity.from(quantity),
  price: Price.from(price),
});

const trade = (orderId: OrderId, quantity: string, price: string, tradeId = 'trade-1'): ExecutedTrade => ({
  tradeId,
  orderId,
  market,
  quantity: Quantity.from(quantity),
  price: Price.from(price),
});

const balanceOf = (wallet: Wallet, asset: AssetId) => {
  const balance = wallet.balanceOf(asset);
  return { available: balance.available.toString(), reserved: balance.reserved.toString() };
};

describe('Wallet: deposit and withdraw', () => {
  test('Should add a deposit to available and record a ledger line', () => {
    // Given
    const wallet = walletWith({});

    // When
    wallet.deposit(usd, Quantity.from('100.25'), 2, now);

    // Then
    expect(balanceOf(wallet, usd)).toEqual({ available: '100.25000000', reserved: '0.00000000' });
    expect(wallet.pendingLedger().at(-1)).toMatchObject({ assetId: 'USD', availableDelta: '100.25000000', reason: 'DEPOSIT' });
  });

  test.each([
    ['zero', '0'],
    ['more decimals than USD accepts', '1.001'],
  ])('Should reject a deposit of %s', (_case, quantity) => {
    // Given
    const wallet = walletWith({});

    // When & Then
    expect(() => wallet.deposit(usd, Quantity.from(quantity), 2, now)).toThrowError(InvalidWalletDataError);
  });

  test('Should never let reserved funds be withdrawn', () => {
    // Given
    const wallet = walletWith({ USD: '100' });
    wallet.reserve(order(buyOrder, 'buy', '1', '80'), now);

    // When & Then
    expect(() => wallet.withdraw(usd, Quantity.from('30'), 2, now)).toThrowError(InsufficientFundsError);
    wallet.withdraw(usd, Quantity.from('20'), 2, now);
    expect(balanceOf(wallet, usd)).toEqual({ available: '0.00000000', reserved: '80.00000000' });
  });
});

describe('Wallet: reservation (saga S2)', () => {
  test('Should reserve quantity × price of USD for a buy and quantity of BTC for a sell', () => {
    // Given
    const wallet = walletWith({ USD: '1000', BTC: '2' });

    // When
    wallet.reserve(order(buyOrder, 'buy', '0.5', '1000'), now);
    wallet.reserve(order(sellOrder, 'sell', '1.25', '900'), now);

    // Then
    expect(balanceOf(wallet, usd)).toEqual({ available: '500.00000000', reserved: '500.00000000' });
    expect(balanceOf(wallet, btc)).toEqual({ available: '0.75000000', reserved: '1.25000000' });
  });

  test('Should consider open reservations: the same balance cannot be reserved twice', () => {
    // Given
    const wallet = walletWith({ USD: '100' });
    wallet.reserve(order(buyOrder, 'buy', '1', '60'), now);

    // When & Then
    expect(() => wallet.reserve(order(sellOrder, 'buy', '1', '60'), now)).toThrowError(InsufficientFundsError);
  });

  test('Should ignore a repeated reservation of the same order', () => {
    // Given
    const wallet = walletWith({ USD: '100' });
    wallet.reserve(order(buyOrder, 'buy', '1', '60'), now);
    wallet.pullEvents();

    // When
    wallet.reserve(order(buyOrder, 'buy', '1', '60'), now);

    // Then
    expect(balanceOf(wallet, usd)).toEqual({ available: '40.00000000', reserved: '60.00000000' });
    expect(wallet.pullEvents()).toEqual([]);
  });

  test('Should emit FundsReserved and one BalanceChanged with the version the wallet will have', () => {
    // Given
    const wallet = walletWith({ USD: '100' });

    // When
    wallet.reserve(order(buyOrder, 'buy', '1', '60'), now);

    // Then
    expect(wallet.pullEvents()).toEqual([
      { type: 'FundsReserved', orderId: buyOrder.value, accountId: wallet.accountId.value, assetId: 'USD', amount: '60.00000000', occurredAt: now },
      {
        type: 'BalanceChanged',
        accountId: wallet.accountId.value,
        assetId: 'USD',
        available: '40.00000000',
        reserved: '60.00000000',
        version: 1,
        occurredAt: now,
      },
    ]);
  });
});

describe('Wallet: settlement (saga S3)', () => {
  test('Should give back to the buyer the difference between its limit and the maker price', () => {
    // Given: bought 10 BTC with limit 83,000; the trade executes 5 at 82,400
    const wallet = walletWith({ USD: '830000' });
    wallet.reserve(order(buyOrder, 'buy', '10', '83000'), now);

    // When
    wallet.settleAsBuyer(trade(buyOrder, '5', '82400'), now);

    // Then: 5 × 83,000 leaves the reservation, 5 × 82,400 is paid, 3,000 returns, 5 BTC arrive
    expect(balanceOf(wallet, usd)).toEqual({ available: '3000.00000000', reserved: '415000.00000000' });
    expect(balanceOf(wallet, btc)).toEqual({ available: '5.00000000', reserved: '0.00000000' });
  });

  test('Should pay the seller quantity × trade price and take the BTC from its reservation', () => {
    // Given
    const wallet = walletWith({ BTC: '5' });
    wallet.reserve(order(sellOrder, 'sell', '5', '82400'), now);

    // When
    wallet.settleAsSeller(trade(sellOrder, '5', '83000'), now);

    // Then
    expect(balanceOf(wallet, btc)).toEqual({ available: '0.00000000', reserved: '0.00000000' });
    expect(balanceOf(wallet, usd)).toEqual({ available: '415000.00000000', reserved: '0.00000000' });
  });

  test('Should reach the same balance whether the fill or the removal arrives first (commutative)', () => {
    // Given two identical wallets with a buy of 10 @ 100
    const fillFirst = walletWith({ USD: '1000' });
    const removalFirst = walletWith({ USD: '1000' });
    fillFirst.reserve(order(buyOrder, 'buy', '10', '100'), now);
    removalFirst.reserve(order(buyOrder, 'buy', '10', '100'), now);

    // When: 4 execute at 90 and 6 leave the book, in opposite orders
    fillFirst.settleAsBuyer(trade(buyOrder, '4', '90'), now);
    fillFirst.releaseRemaining(buyOrder, Quantity.from('6'), now);
    removalFirst.releaseRemaining(buyOrder, Quantity.from('6'), now);
    removalFirst.settleAsBuyer(trade(buyOrder, '4', '90'), now);

    // Then
    const expected = { available: '640.00000000', reserved: '0.00000000' };
    expect(balanceOf(fillFirst, usd)).toEqual(expected);
    expect(balanceOf(removalFirst, usd)).toEqual(expected);
    expect(balanceOf(fillFirst, btc)).toEqual(balanceOf(removalFirst, btc));
  });

  test('Should refuse a buyer price above its limit and a settlement of an unknown reservation', () => {
    // Given
    const wallet = walletWith({ USD: '1000' });
    wallet.reserve(order(buyOrder, 'buy', '1', '100'), now);

    // When & Then
    expect(() => wallet.settleAsBuyer(trade(buyOrder, '1', '101'), now)).toThrowError(InvalidWalletDataError);
    expect(() => wallet.settleAsSeller(trade(sellOrder, '1', '100'), now)).toThrowError(ReservationNotFoundError);
  });

  test('Should refuse to use more than what is still reserved', () => {
    // Given
    const wallet = walletWith({ BTC: '1' });
    wallet.reserve(order(sellOrder, 'sell', '1', '100'), now);

    // When & Then
    expect(() => wallet.settleAsSeller(trade(sellOrder, '2', '100'), now)).toThrowError(ReservationOverdrawnError);
  });
});

describe('Wallet: release and compensation (sagas S4 and S2)', () => {
  test('Should release what a self-trade-prevented sell did not execute', () => {
    // Given
    const wallet = walletWith({ BTC: '3' });
    wallet.reserve(order(sellOrder, 'sell', '3', '100'), now);

    // When
    wallet.releaseRemaining(sellOrder, Quantity.from('3'), now);

    // Then
    expect(balanceOf(wallet, btc)).toEqual({ available: '3.00000000', reserved: '0.00000000' });
  });

  test('Should give back everything still reserved when the order is voided, and do nothing a second time', () => {
    // Given
    const wallet = walletWith({ USD: '500' });
    wallet.reserve(order(buyOrder, 'buy', '2', '100'), now);

    // When
    wallet.voidReservation(buyOrder, now);
    wallet.voidReservation(buyOrder, now);

    // Then
    expect(balanceOf(wallet, usd)).toEqual({ available: '500.00000000', reserved: '0.00000000' });
    expect(wallet.pendingLedger().filter((entry) => entry.reason === 'VOID')).toHaveLength(1);
  });

  test('Should do nothing when the voided order was never reserved', () => {
    // Given
    const wallet = walletWith({ USD: '500' });

    // When
    wallet.voidReservation(buyOrder, now);

    // Then
    expect(wallet.pullEvents()).toEqual([]);
  });
});
