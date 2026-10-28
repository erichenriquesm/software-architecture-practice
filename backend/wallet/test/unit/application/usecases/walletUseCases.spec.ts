import { describe, expect, test } from 'vitest';
import { GetBalances } from '../../../../src/application/usecases/getBalances.js';
import { ConcurrentWalletUpdateError, InsufficientFundsError, InvalidWalletDataError, WalletNotFoundError } from '../../../../src/domain/errors.js';
import { AccountId } from '../../../../src/domain/valueObjects/accountId.js';
import { AssetId } from '../../../../src/domain/valueObjects/assetId.js';
import { accountId, orderId, otherAccountId, walletUseCases } from './walletUseCases.js';

const buyOrder = (quantity: string, price: string) => ({ orderId, accountId, marketId: 'BTC-USD', side: 'buy', quantity, price });

const usdOf = async (useCases: ReturnType<typeof walletUseCases>) => {
  const wallet = await useCases.repository.findByAccount(AccountId.from(accountId));
  const balance = wallet?.balanceOf(AssetId.from('USD'));
  return { available: balance?.available.toString(), reserved: balance?.reserved.toString() };
};

const eventTypes = (useCases: ReturnType<typeof walletUseCases>) => useCases.dispatcher.dispatched.map((event) => event.type);

describe('Use case: Deposit and Withdraw', () => {
  test('Should open the wallet of an existing account on the first deposit and publish BalanceChanged version 1', async () => {
    // Given
    const useCases = walletUseCases();

    // When
    await useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '150.50' });

    // Then
    expect(await usdOf(useCases)).toEqual({ available: '150.50000000', reserved: '0.00000000' });
    expect(useCases.dispatcher.dispatched).toMatchObject([{ type: 'BalanceChanged', assetId: 'USD', version: 1 }]);
  });

  test('Should refuse an account the account service does not know, and an asset the catalog does not trade', async () => {
    // Given
    const useCases = walletUseCases();

    // When & Then
    await expect(useCases.deposit.execute({ accountId: otherAccountId, assetId: 'USD', quantity: '1' })).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(useCases.deposit.execute({ accountId, assetId: 'ETH', quantity: '1' })).rejects.toBeInstanceOf(InvalidWalletDataError);
  });

  test('Should reload and try again when another change saved the wallet first, giving up after 3 attempts', async () => {
    // Given
    const useCases = walletUseCases();
    useCases.repository.conflictsToSimulate = 2;

    // When
    await useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '10' });
    useCases.repository.conflictsToSimulate = 3;

    // Then
    expect(useCases.repository.saves).toBe(1);
    await expect(useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '10' })).rejects.toBeInstanceOf(ConcurrentWalletUpdateError);
  });

  test('Should refuse to withdraw more than is available', async () => {
    // Given
    const useCases = walletUseCases();
    await useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '10' });

    // When & Then
    await expect(useCases.withdraw.execute({ accountId, assetId: 'USD', quantity: '10.01' })).rejects.toBeInstanceOf(InsufficientFundsError);
  });
});

describe('Use case: ReserveFunds (saga S2)', () => {
  test('Should reserve and publish FundsReserved and BalanceChanged', async () => {
    // Given
    const useCases = walletUseCases();
    await useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '100' });
    useCases.dispatcher.dispatched.length = 0;

    // When
    await useCases.reserveFunds.execute(buyOrder('1', '60'));

    // Then
    expect(eventTypes(useCases)).toEqual(['FundsReserved', 'BalanceChanged']);
    expect(await usdOf(useCases)).toEqual({ available: '40.00000000', reserved: '60.00000000' });
  });

  test('Should publish a rejection instead of throwing when funds are not enough', async () => {
    // Given
    const useCases = walletUseCases();
    await useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '10' });
    useCases.dispatcher.dispatched.length = 0;

    // When
    await useCases.reserveFunds.execute(buyOrder('1', '60'));

    // Then
    expect(useCases.dispatcher.dispatched).toMatchObject([{ type: 'FundsReservationRejected', reason: 'INSUFFICIENT_FUNDS', orderId }]);
    expect(await usdOf(useCases)).toEqual({ available: '10.00000000', reserved: '0.00000000' });
  });

  test('Should publish WALLET_NOT_FOUND for an account that does not exist', async () => {
    // Given
    const useCases = walletUseCases();

    // When
    await useCases.reserveFunds.execute({ ...buyOrder('1', '60'), accountId: otherAccountId });

    // Then
    expect(useCases.dispatcher.dispatched).toMatchObject([{ type: 'FundsReservationRejected', reason: 'WALLET_NOT_FOUND' }]);
  });

  test('Should reject an order of a market the catalog does not have', async () => {
    // Given
    const useCases = walletUseCases();

    // When & Then
    await expect(useCases.reserveFunds.execute({ ...buyOrder('1', '60'), marketId: 'ETH-USD' })).rejects.toBeInstanceOf(InvalidWalletDataError);
  });
});

describe('Use case: CompensateReservation (saga S2 compensation)', () => {
  test('Should leave the balance intact when order.voided arrives before order.placed', async () => {
    // Given
    const useCases = walletUseCases();
    await useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '100' });
    useCases.dispatcher.dispatched.length = 0;

    // When
    await useCases.compensateReservation.execute(orderId, accountId);
    await useCases.reserveFunds.execute(buyOrder('1', '60'));

    // Then
    expect(useCases.voidedOrders.voided.has(orderId)).toBe(true);
    expect(useCases.dispatcher.dispatched).toEqual([]);
    expect(await usdOf(useCases)).toEqual({ available: '100.00000000', reserved: '0.00000000' });
  });

  test('Should give back the reservation when order.voided arrives after order.placed', async () => {
    // Given
    const useCases = walletUseCases();
    await useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '100' });
    await useCases.reserveFunds.execute(buyOrder('1', '60'));

    // When
    await useCases.compensateReservation.execute(orderId, accountId);

    // Then
    expect(await usdOf(useCases)).toEqual({ available: '100.00000000', reserved: '0.00000000' });
  });
});

describe('Use cases: SettleTradeSide, ReleaseReservation, OpenWallet and GetBalances', () => {
  test('Should settle the buyer side and release what was not executed', async () => {
    // Given
    const useCases = walletUseCases();
    await useCases.deposit.execute({ accountId, assetId: 'USD', quantity: '1000' });
    await useCases.reserveFunds.execute(buyOrder('10', '100'));

    // When
    await useCases.settleTradeSide.execute({ tradeId: 't-1', orderId, accountId, role: 'buyer', marketId: 'BTC-USD', quantity: '4', price: '90' });
    await useCases.releaseReservation.execute({ orderId, accountId, remainingQuantity: '6' });

    // Then
    expect(await usdOf(useCases)).toEqual({ available: '640.00000000', reserved: '0.00000000' });
  });

  test('Should open a wallet once, however many times account.created arrives', async () => {
    // Given
    const useCases = walletUseCases();

    // When
    await useCases.openWallet.execute(accountId);
    await useCases.openWallet.execute(accountId);

    // Then
    expect(useCases.repository.saves).toBe(1);
  });

  test('Should answer WalletNotFoundError when there is no wallet', async () => {
    // Given
    const getBalances = new GetBalances({ findByAccount: async () => undefined });

    // When & Then
    await expect(getBalances.execute(accountId)).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
